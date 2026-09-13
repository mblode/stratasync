import Foundation

@MainActor
@Observable
public final class SyncEngine {
    public private(set) var state: SyncClientState = .disconnected
    public private(set) var connectionState: ConnectionState = .disconnected
    public private(set) var lastSyncId: SyncId = zeroSyncId
    public private(set) var lastError: Error?
    public private(set) var pendingCount: Int = 0
    public private(set) var isLocalDataReady = false
    public private(set) var boundAccountId: String?

    public var syncStatus: SyncStatus {
        resolvedSyncStatus(
            state: state,
            connectionState: connectionState,
            lastError: lastError,
            pendingCount: pendingCount
        )
    }

    public var hasPendingChanges: Bool {
        pendingCount > 0
    }

    /// Whether the engine is between a successful start() and stop(). Callers
    /// use this to pick recovery: restartSubscription() is a no-op when the
    /// engine isn't running, so they should start() instead.
    public var isRunning: Bool {
        orchestrator.running
    }

    public let modelStore: SyncModelStore

    private let historyManager = HistoryManager()
    private let runtime: SyncRuntime
    private let transport: SyncTransport
    private let storage: StorageAdapter
    private let orchestrator: SyncOrchestrator
    private let outboxManager: OutboxManager
    private let stateQueue: StateQueue
    private var clientId: String
    private var usesPreviewStore = false
    private var accountReadinessTask: (
        id: UUID,
        accountId: String?,
        startsTransport: Bool,
        task: Task<Void, Error>
    )?

    convenience init(
        syncEndpoint: String,
        wsEndpoint: String,
        getToken: @escaping () async -> String?,
        storage: StorageAdapter = SQLiteStorage(),
        modelStore: SyncModelStore? = nil,
        schemaHash: String = ""
    ) {
        let transport = SyncTransport(
            syncEndpoint: syncEndpoint,
            wsEndpoint: wsEndpoint,
            getToken: getToken
        )
        self.init(
            transport: transport,
            storage: storage,
            modelStore: modelStore ?? SyncModelStore(),
            schemaHash: schemaHash
        )
    }

    /// - Parameter schemaHash: identifies the client's model schema. When
    ///   non-empty and different from the persisted hash (or when none is
    ///   stored), the next start performs a full re-bootstrap so a shipped model
    ///   change can't silently decode stale rows. The empty-string default
    ///   preserves the previous no-hash behavior.
    ///
    ///   Pass `modelStore.registrationsHash` to derive this from the registered
    ///   models rather than maintaining a hash by hand. It covers model names,
    ///   field names and field codecs — everything that can corrupt a decode —
    ///   and deliberately omits indexes and load strategies, which change which
    ///   rows are fetched but never how a persisted row is read back. Adopting
    ///   it, or changing its granularity, costs one full re-bootstrap per
    ///   existing install, since the persisted hash differs. The download for
    ///   that bootstrap is not serialized on the mutation queue, so local
    ///   creates stay responsive for its duration; only the local snapshot apply
    ///   is exclusive.
    public init(
        transport: SyncTransport,
        storage: StorageAdapter,
        modelStore: SyncModelStore,
        clientId: String = UUID().uuidString,
        schemaHash: String = "",
        runtime: SyncRuntime? = nil
    ) {
        let runtime = runtime ?? .live
        self.runtime = runtime
        let stateQueue = StateQueue()
        let outboxManager = OutboxManager(
            storage: storage,
            transport: transport,
            clientId: clientId,
            runtime: runtime
        )
        let orchestrator = SyncOrchestrator(
            storage: storage,
            transport: transport,
            modelStore: modelStore,
            outboxManager: outboxManager,
            stateQueue: stateQueue,
            clientSchemaHash: schemaHash,
            runtime: runtime
        )

        self.transport = transport
        self.storage = storage
        self.modelStore = modelStore
        self.clientId = clientId
        self.outboxManager = outboxManager
        self.orchestrator = orchestrator
        self.stateQueue = stateQueue

        orchestrator.onCursorChange = { [weak self] cursor in
            self?.lastSyncId = cursor
        }
        orchestrator.onStateChange = { [weak self] newState in
            self?.state = newState
        }
        orchestrator.onConnectionStateChange = { [weak self] newState in
            self?.connectionState = newState
        }
        orchestrator.onEvent = { [weak self] event in
            self?.handleEvent(event)
        }
        orchestrator.onClientIdLoaded = { [weak self] loadedClientId in
            self?.clientId = loadedClientId
            self?.outboxManager.setClientId(loadedClientId)
        }
        orchestrator.onConflict = { [weak self] _ in
            self?.lastError = nil
        }
        outboxManager.onTransactionRejected = { [weak self] tx in
            await self?.handleRejectedTransaction(tx)
        }
        outboxManager.onPendingCountChange = { [weak self] count in
            self?.pendingCount = count
        }

        historyManager.applyMutation = { [weak self] action, modelName, modelId, payload in
            guard let self else { return nil }
            switch action {
            case "I":
                var data = payload
                data["id"] = modelId
                try await self.create(modelName: modelName, data: data)
                return nil
            case "D":
                try await self.delete(modelName: modelName, id: modelId)
                return nil
            case "U":
                try await self.update(modelName: modelName, id: modelId, changes: payload)
                return nil
            case "A":
                try await self.archive(modelName: modelName, id: modelId)
                return nil
            case "V":
                try await self.unarchive(modelName: modelName, id: modelId)
                return nil
            default:
                return nil
            }
        }
    }

    @discardableResult
    public func register<T: SyncModel>(_ type: T.Type) -> IdentityMap<T> {
        modelStore.register(type)
    }

    public func start(groups: [String]) async throws {
        lastError = nil
        isLocalDataReady = modelStore.hasLoadedData
        do {
            try await orchestrator.start(groups: groups)
        } catch {
            lastError = error
            throw error
        }
    }

    public func stop() async {
        await orchestrator.stop()
    }

    /// Resets the stable engine at an authentication boundary and hydrates the
    /// selected account's local database without starting network transport.
    /// Passing `nil` signs out locally: memory is cleared while every account's
    /// persisted snapshot and outbox remain intact.
    public func resetForAccount(_ accountId: String?) async throws {
        if let readiness = accountReadinessTask {
            accountReadinessTask = nil
            readiness.task.cancel()
            _ = try? await readiness.task.value
        }

        let resetId = UUID()
        let resetTask = Task { @MainActor [weak self] in
            guard let self else { return }
            try await self.performAccountReset(accountId)
        }
        accountReadinessTask = (resetId, accountId, false, resetTask)
        defer {
            if accountReadinessTask?.id == resetId {
                accountReadinessTask = nil
            }
        }
        try await resetTask.value
    }

    /// Coalesces concurrent cold-start/readiness requests for one account. A
    /// request for a different account cancels and joins the older request
    /// before touching storage, preventing token/database cross-contamination.
    public func ensureAccountReady(
        _ accountId: String,
        groups: [String] = []
    ) async throws {
        if boundAccountId == accountId, isLocalDataReady, isRunning {
            return
        }

        if let readiness = accountReadinessTask {
            if readiness.accountId == accountId {
                try await readiness.task.value
                if readiness.startsTransport {
                    return
                }
                if accountReadinessTask?.id == readiness.id {
                    accountReadinessTask = nil
                }
            } else {
                accountReadinessTask = nil
                readiness.task.cancel()
                _ = try? await readiness.task.value
            }
        }

        let readinessId = UUID()
        let readinessTask = Task { @MainActor [weak self] in
            guard let self else { return }
            if self.boundAccountId != accountId {
                try await self.performAccountReset(accountId)
            }
            try Task.checkCancellation()
            if !self.isRunning {
                try await self.start(groups: groups)
            }
        }
        accountReadinessTask = (readinessId, accountId, true, readinessTask)
        defer {
            if accountReadinessTask?.id == readinessId {
                accountReadinessTask = nil
            }
        }
        try await readinessTask.value
    }

    private func performAccountReset(_ accountId: String?) async throws {
        isLocalDataReady = false
        lastError = nil
        pendingCount = 0

        await orchestrator.stop()
        await outboxManager.resetForAccountBoundary()
        modelStore.clearAll()
        historyManager.clear()
        orchestrator.resetForAccountBoundary()

        state = .disconnected
        connectionState = .disconnected
        lastSyncId = zeroSyncId
        boundAccountId = nil
        usesPreviewStore = false

        guard let accountStorage = storage as? any AccountScopedStorageAdapter else {
            throw SyncEngineError.accountScopedStorageRequired
        }

        do {
            try await accountStorage.selectAccount(accountId)
            guard let accountId else { return }

            let hydrated = try await orchestrator.hydrateSelectedAccount()
            boundAccountId = accountId
            lastSyncId = hydrated.meta.lastSyncId
            pendingCount = hydrated.pendingCount
            isLocalDataReady = !hydrated.meta.groupChangePending
        } catch {
            lastError = error
            throw error
        }
    }

    public func restartSubscription() async {
        await orchestrator.restartSubscription()
    }

    public func update(modelName: String, id: String, changes: [String: Any]) async throws {
        try await stateQueue.run { [self] in
            try requireAuthoritativeLocalState()
            try await updateOptimisticAndQueue(modelName: modelName, id: id, changes: changes)?.value
        }
    }

    /// Applies an update to the model store synchronously and returns a task
    /// that durably enqueues it (rolling back the optimistic change if the
    /// enqueue fails). The optimistic write is visible before the returned task
    /// is awaited; `nil` means there was nothing to change. This is the
    /// non-serialized primitive `update()` is built on — callers wanting the
    /// state-queue serialization should use `update()`.
    public func updateOptimisticAndQueue(
        modelName: String,
        id: String,
        changes: [String: Any]
    ) -> Task<Void, Error>? {
        if orchestrator.isGroupChangeReconcilePending {
            return Task { throw SyncEngineError.privacyReconciliationPending }
        }
        guard let original = modelStore.snapshot(modelName: modelName, id: id) else {
            return nil
        }

        var effectiveChanges: [String: Any] = [:]
        for (key, value) in changes {
            let existingValue = original[key]
            if !valuesEqual(existingValue, value) {
                effectiveChanges[key] = value
            }
        }
        if effectiveChanges.isEmpty {
            return nil
        }

        var originalSnapshot: [String: Any] = [:]
        for key in effectiveChanges.keys {
            originalSnapshot[key] = original[key] ?? NSNull()
        }

        let entry = historyManager.buildEntry(
            action: "U",
            modelName: modelName,
            modelId: id,
            payload: effectiveChanges,
            originalState: originalSnapshot
        )
        modelStore.update(modelName: modelName, id: id, changes: effectiveChanges)

        if usesPreviewStore {
            historyManager.record(entry: entry)
            return nil
        }

        return Task { [self] in
            do {
                let transaction = try await outboxManager.update(
                    modelName: modelName,
                    modelId: id,
                    changes: effectiveChanges,
                    original: originalSnapshot
                )
                historyManager.record(entry: entry, transactionId: transaction.clientTxId)
            } catch {
                if !orchestrator.isGroupChangeReconcilePending {
                    modelStore.set(modelName: modelName, data: original)
                }
                throw error
            }
        }
    }

    public func create(modelName: String, data: [String: Any]) async throws {
        try await createOptimisticAndQueue(modelName: modelName, data: data)
    }

    /// Applies an insert optimistically, but does not return until the transaction
    /// is durable in the local outbox. A caller may safely report success after
    /// this method returns, even if the process is suspended before network sync.
    public func createOptimisticAndQueue(modelName: String, data: [String: Any]) async throws {
        try await stateQueue.run { [self] in
            let created = try createOptimisticIfAbsent(
                modelName: modelName,
                data: data,
                existingId: { nil }
            )
            try await created.persistence.value
        }
    }

    /// Reuses a matching optimistic record or inserts a new one atomically on
    /// the main actor. The lookup and optimistic insert happen before the first
    /// suspension, so concurrent UI events cannot both pass the absence check.
    @discardableResult
    public func createOptimisticAndQueueIfAbsent(
        modelName: String,
        data: [String: Any],
        existingId: () -> String?
    ) async throws -> String {
        let created = try createOptimisticIfAbsent(
            modelName: modelName,
            data: data,
            existingId: existingId
        )
        try await created.persistence.value
        return created.id
    }

    /// Synchronous reuse-check + optimistic insert, returning the record id and
    /// a task that durably persists it (rolling back the optimistic insert on
    /// failure). A reuse hit returns the existing id with an already-completed
    /// task. The insert is visible before the returned task is awaited.
    public func createOptimisticIfAbsent(
        modelName: String,
        data: [String: Any],
        existingId: () -> String?
    ) throws -> (id: String, persistence: Task<Void, Error>) {
        if let existingId = existingId() {
            return (existingId, Task<Void, Error> {})
        }

        let prepared = try prepareOptimisticCreate(modelName: modelName, data: data)

        if usesPreviewStore {
            historyManager.record(entry: prepared.historyEntry)
            return (prepared.id, Task<Void, Error> {})
        }

        let persistence = Task<Void, Error> { [self] in
            do {
                let transaction = try await outboxManager.insert(
                    modelName: modelName,
                    modelId: prepared.id,
                    data: prepared.data
                )
                historyManager.record(
                    entry: prepared.historyEntry,
                    transactionId: transaction.clientTxId
                )
            } catch {
                modelStore.delete(modelName: modelName, id: prepared.id)
                throw error
            }
        }
        return (prepared.id, persistence)
    }

    private func prepareOptimisticCreate(
        modelName: String,
        data: [String: Any]
    ) throws -> (id: String, data: [String: Any], historyEntry: HistoryManager.HistoryEntry) {
        try requireAuthoritativeLocalState()
        let data = canonicalSyncIdentityFields(data)
        guard let id = data["id"] as? String, !id.isEmpty else {
            throw SyncEngineError.invalidInsert(modelName: modelName)
        }
        let entry = historyManager.buildEntry(
            action: "I",
            modelName: modelName,
            modelId: id,
            payload: data,
            originalState: nil
        )
        createOptimistic(modelName: modelName, data: data)
        return (id, data, entry)
    }

    public func delete(modelName: String, id: String) async throws {
        try await stateQueue.run { [self] in
            try requireAuthoritativeLocalState()
            guard let original = modelStore.snapshot(modelName: modelName, id: id) else {
                return
            }
            let entry = historyManager.buildEntry(
                action: "D",
                modelName: modelName,
                modelId: id,
                payload: [:],
                originalState: original
            )
            modelStore.delete(modelName: modelName, id: id)
            if usesPreviewStore {
                historyManager.record(entry: entry)
                return
            }
            do {
                let transaction = try await outboxManager.delete(
                    modelName: modelName,
                    modelId: id,
                    original: original
                )
                historyManager.record(entry: entry, transactionId: transaction.clientTxId)
            } catch {
                modelStore.set(modelName: modelName, data: original)
                throw error
            }
        }
    }

    public func archive(modelName: String, id: String) async throws {
        try await stateQueue.run { [self] in
            try requireAuthoritativeLocalState()
            guard let original = modelStore.snapshot(modelName: modelName, id: id) else {
                return
            }
            let archivedAt = runtime.now()
            let entry = historyManager.buildEntry(
                action: "A",
                modelName: modelName,
                modelId: id,
                payload: ["archivedAt": archivedAt, "updatedAt": archivedAt],
                originalState: original
            )
            modelStore.update(
                modelName: modelName,
                id: id,
                changes: [
                    "archivedAt": archivedAt,
                    "updatedAt": archivedAt,
                ]
            )
            if usesPreviewStore {
                historyManager.record(entry: entry)
                return
            }
            do {
                let transaction = try await outboxManager.archive(
                    modelName: modelName,
                    modelId: id,
                    original: original
                )
                historyManager.record(entry: entry, transactionId: transaction.clientTxId)
            } catch {
                modelStore.set(modelName: modelName, data: original)
                throw error
            }
        }
    }

    public func unarchive(modelName: String, id: String) async throws {
        try await stateQueue.run { [self] in
            try requireAuthoritativeLocalState()
            guard let original = modelStore.snapshot(modelName: modelName, id: id) else {
                return
            }
            let updatedAt = runtime.now()
            let payload: [String: Any] = [
                "archivedAt": NSNull(),
                "updatedAt": updatedAt,
            ]
            let entry = historyManager.buildEntry(
                action: "V",
                modelName: modelName,
                modelId: id,
                payload: payload,
                originalState: original
            )
            modelStore.update(
                modelName: modelName,
                id: id,
                changes: payload
            )
            if usesPreviewStore {
                historyManager.record(entry: entry)
                return
            }
            do {
                let transaction = try await outboxManager.unarchive(
                    modelName: modelName,
                    modelId: id,
                    original: original
                )
                historyManager.record(entry: entry, transactionId: transaction.clientTxId)
            } catch {
                modelStore.set(modelName: modelName, data: original)
                throw error
            }
        }
    }

    public func enablePreviewStore(lastSyncId: SyncId = "1") {
        usesPreviewStore = true
        state = .syncing
        connectionState = .connected
        self.lastSyncId = lastSyncId
        lastError = nil
        pendingCount = 0
        isLocalDataReady = true
    }

    public var canUndo: Bool { historyManager.canUndo }
    public var canRedo: Bool { historyManager.canRedo }

    public func undo() async {
        await historyManager.undo()
    }

    public func redo() async {
        await historyManager.redo()
    }

    /// Run related mutations as one undoable group, matching the web client's
    /// `runAsUndoGroup` semantics.
    public func runAsUndoGroup<T>(_ work: () async throws -> T) async rethrows -> T {
        try await historyManager.runAsGroup(work)
    }

    private func createOptimistic(modelName: String, data: [String: Any]) {
        modelStore.set(modelName: modelName, data: data)
    }

    private func requireAuthoritativeLocalState() throws {
        if orchestrator.isGroupChangeReconcilePending {
            throw SyncEngineError.privacyReconciliationPending
        }
    }

    /// Reverts a transaction explicitly rejected by the server, so the UI
    /// cannot keep phantom changes. Transient failures remain queued.
    private func handleRejectedTransaction(_ tx: Transaction) async {
        // Serialized against mutations and delta application so the rollback +
        // replay never interleaves with an in-flight optimistic write or a
        // delta packet.
        _ = try? await stateQueue.run { [self] in
            historyManager.removeByTxId(tx.clientTxId)
            let suppressPrivacyRollback = orchestrator.shouldSuppressPrivacyRollback(tx)
            if tx.action == .insert {
                modelStore.delete(modelName: tx.modelName, id: tx.modelId)
            } else if !suppressPrivacyRollback {
                switch tx.action {
                case .delete:
                    if let original = tx.original {
                        modelStore.set(modelName: tx.modelName, data: original)
                    }
                case .update, .archive, .unarchive:
                    if let original = tx.original {
                        modelStore.update(modelName: tx.modelName, id: tx.modelId, changes: original)
                    }
                case .insert:
                    break
                }
            }

            // A later optimistic mutation may depend on the rejected
            // transaction's intermediate value. Reapply every later durable
            // transaction for this record in replay order so rollback cannot
            // clobber accepted/pending UI.
            let laterTransactions = await storage.getOutbox().filter { candidate in
                guard candidate.modelName == tx.modelName,
                      candidate.modelId == tx.modelId,
                      candidate.clientTxId != tx.clientTxId,
                      candidate.state != .failed,
                      candidate.state != .completed else {
                    return false
                }
                if candidate.createdAt != tx.createdAt {
                    return candidate.createdAt > tx.createdAt
                }
                return candidate.clientTxId > tx.clientTxId
            }
            if !suppressPrivacyRollback {
                for later in laterTransactions {
                    reapplyOptimisticTransaction(later)
                }
            }

            lastError = SyncEngineError.transactionRejected(
                modelName: tx.modelName,
                modelId: tx.modelId,
                reason: tx.lastError
            )

            // Rejection has been surfaced and its optimistic overlay removed.
            // A failed row is not retryable work and must not accumulate in the
            // durable outbox. Keep it only if this storage removal fails.
            try await storage.removeFromOutbox(clientTxId: tx.clientTxId)
            pendingCount = await outboxManager.getPendingCount()
        }
    }

    private func reapplyOptimisticTransaction(_ tx: Transaction) {
        switch tx.action {
        case .insert:
            modelStore.set(modelName: tx.modelName, data: tx.payload)
        case .delete:
            modelStore.delete(modelName: tx.modelName, id: tx.modelId)
        case .update, .archive, .unarchive:
            modelStore.update(modelName: tx.modelName, id: tx.modelId, changes: tx.payload)
        }
    }

    private func handleEvent(_ event: SyncClientEvent) {
        switch event {
        case .localDataReady:
            isLocalDataReady = true
        case .syncError(let error):
            lastError = error
        case .outboxChange(let count):
            pendingCount = count
        case .syncComplete(let syncId):
            lastSyncId = syncId
            lastError = nil
        default:
            break
        }
    }
}

public enum SyncEngineError: Error, LocalizedError {
    case accountScopedStorageRequired
    case invalidInsert(modelName: String)
    case privacyReconciliationPending
    case transactionRejected(modelName: String, modelId: String, reason: String?)

    public var errorDescription: String? {
        switch self {
        case .accountScopedStorageRequired:
            "Account switching requires account-scoped storage"
        case .invalidInsert(let modelName):
            "Cannot create \(modelName) without an id"
        case .privacyReconciliationPending:
            "Sync is reconciling access; retry the change when sync completes"
        case .transactionRejected(let modelName, let modelId, let reason):
            "Change to \(modelName) \(modelId) was rejected: \(reason ?? "unknown error")"
        }
    }
}

func resolvedSyncStatus(
    state: SyncClientState,
    connectionState: ConnectionState,
    lastError: Error?,
    pendingCount: Int
) -> SyncStatus {
    if let lastError {
        return isOfflineSyncError(lastError) ? .offline : .error
    }

    if state == .error || connectionState == .error {
        return .error
    }

    if state == .connecting ||
        state == .bootstrapping ||
        state == .syncing ||
        connectionState == .connecting ||
        connectionState == .reconnecting ||
        pendingCount > 0 {
        return .syncing
    }

    if state == .disconnected || connectionState == .disconnected {
        return .offline
    }

    return .synced
}

private func valuesEqual(_ a: Any?, _ b: Any?) -> Bool {
    if a == nil && b == nil { return true }
    if a == nil || b == nil { return false }
    if a is NSNull && b is NSNull { return true }
    if a is NSNull || b is NSNull { return false }

    switch (a, b) {
    case (let lhs as String, let rhs as String):
        return lhs == rhs
    case (let lhs as NSString, let rhs as NSString):
        return lhs == rhs
    case (let lhs as Int, let rhs as Int):
        return lhs == rhs
    case (let lhs as Double, let rhs as Double):
        return lhs == rhs
    case (let lhs as Int, let rhs as Double):
        return Double(lhs) == rhs
    case (let lhs as Double, let rhs as Int):
        return lhs == Double(rhs)
    case (let lhs as Bool, let rhs as Bool):
        return lhs == rhs
    case (let lhs as NSNumber, let rhs as NSNumber):
        return lhs == rhs
    default:
        return false
    }
}
