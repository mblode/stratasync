import Foundation
import Testing
@testable import StrataSync

// MARK: - Mock Transport

@MainActor
final class MockSyncTransport: SyncTransport {
    var mutateHandler: ((TransactionBatch) async throws -> MutateResult)?
    var fetchDeltasHandler: ((SyncId, Int?) async throws -> DeltaPacket)?
    var bootstrapEvents: [BootstrapEvent] = []
    var bootstrapStreamProvider: (() -> AsyncThrowingStream<BootstrapEvent, Error>)?
    var subscribeStreamProvider: ((Int) -> AsyncThrowingStream<DeltaPacket, Error>)?

    private(set) var mutateBatches: [TransactionBatch] = []
    private(set) var fetchDeltasCursors: [SyncId] = []
    private(set) var bootstrapCount = 0
    private(set) var bootstrapGroups: [[String]] = []
    private(set) var subscribeCursors: [SyncId] = []

    init() {
        super.init(
            syncEndpoint: "https://example.test/sync",
            wsEndpoint: "wss://example.test/sync/ws",
            getToken: { "test-token" }
        )
    }

    override func mutate(batch: TransactionBatch) async throws -> MutateResult {
        mutateBatches.append(batch)
        if let mutateHandler {
            return try await mutateHandler(batch)
        }
        return MutateResult(
            success: true,
            lastSyncId: zeroSyncId,
            results: batch.transactions.map {
                TransactionResult(clientTxId: $0.clientTxId, success: true, syncId: "1", error: nil)
            }
        )
    }

    override func fetchDeltas(after: SyncId, limit: Int?) async throws -> DeltaPacket {
        fetchDeltasCursors.append(after)
        if let fetchDeltasHandler {
            return try await fetchDeltasHandler(after, limit)
        }
        return DeltaPacket(lastSyncId: after, actions: [], hasMore: false)
    }

    override func bootstrap(syncGroups: [String]) -> AsyncThrowingStream<BootstrapEvent, Error> {
        bootstrapCount += 1
        bootstrapGroups.append(syncGroups)
        if let bootstrapStreamProvider {
            return bootstrapStreamProvider()
        }
        let events = bootstrapEvents
        return AsyncThrowingStream { continuation in
            for event in events {
                continuation.yield(event)
            }
            continuation.finish()
        }
    }

    override func subscribe(
        cursorProvider: @escaping () -> SyncId,
        groups: [String]
    ) -> AsyncThrowingStream<DeltaPacket, Error> {
        subscribeCursors.append(cursorProvider())
        if let subscribeStreamProvider {
            return subscribeStreamProvider(subscribeCursors.count)
        }
        // Default: an open stream that never yields.
        return AsyncThrowingStream { _ in }
    }

    override func close() async {}
}

// MARK: - Helpers

@MainActor
private func waitUntil(
    timeout: TimeInterval = 3,
    _ condition: () async -> Bool
) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return await condition()
}

private actor AsyncGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private(set) var isWaiting = false

    func wait() async {
        isWaiting = true
        await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func open() {
        continuation?.resume()
        continuation = nil
        isWaiting = false
    }
}

private struct StrictRecord: Identifiable, Sendable, SyncModel {
    static let modelName = "StrictRecord"

    let id: String
    var title: String

    init(from dictionary: [String: Any]) throws {
        guard let id = dictionary["id"] as? String else {
            throw TestSupportError.missingField("id")
        }
        guard let title = dictionary["title"] as? String else {
            throw TestSupportError.missingField("title")
        }
        self.id = id
        self.title = title
    }

    func toDictionary() -> [String: Any] {
        ["id": id, "title": title]
    }

    func applying(changes: [String: Any]) -> StrictRecord {
        var copy = self
        if let title = changes["title"] as? String {
            copy.title = title
        }
        return copy
    }
}

private func makeAction(
    syncId: SyncId,
    modelId: String = "task-1",
    action: SyncActionType = .update,
    data: [String: Any],
    clientTxId: String? = nil,
    clientId: String? = nil
) -> SyncAction {
    SyncAction(
        id: syncId,
        modelName: TestRecord.modelName,
        modelId: modelId,
        action: action,
        data: data,
        groupId: nil,
        groups: nil,
        clientTxId: clientTxId,
        clientId: clientId
    )
}

private func seededMeta(cursor: SyncId, clientId: String = "client-a") -> StorageMeta {
    StorageMeta(
        lastSyncId: cursor,
        firstSyncId: cursor,
        subscribedGroups: ["ws-1"],
        clientId: clientId,
        bootstrapComplete: true
    )
}

// MARK: - Outbox Tests

@MainActor
@Suite struct OutboxResilienceTests {
    @Test func optimisticCreateWaitsForDurableOutboxInsert() async throws {
        let storage = MockStorageAdapter()
        let gate = AsyncGate()
        storage.beforeAddToOutbox = { _ in
            await gate.wait()
        }
        let transport = MockSyncTransport()
        let modelStore = SyncModelStore()
        modelStore.register(TestRecord.self)
        let engine = SyncEngine(transport: transport, storage: storage, modelStore: modelStore)
        let data: [String: Any] = ["id": "t1", "title": "Draft", "category": "inbox"]

        let createTask = Task {
            try await engine.createOptimisticAndQueue(modelName: TestRecord.modelName, data: data)
        }

        #expect(await waitUntil { await gate.isWaiting })
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "t1") != nil)
        #expect(await storage.getOutbox().isEmpty)

        await gate.open()
        try await createTask.value

        #expect(await storage.getOutbox().count == 1)
        #expect(engine.canUndo)
    }

    @Test func optimisticCreateIfAbsentCoalescesConcurrentRequests() async throws {
        let storage = MockStorageAdapter()
        let gate = AsyncGate()
        storage.beforeAddToOutbox = { _ in
            await gate.wait()
        }
        let transport = MockSyncTransport()
        let modelStore = SyncModelStore()
        let records = modelStore.register(TestRecord.self)
        let engine = SyncEngine(transport: transport, storage: storage, modelStore: modelStore)

        let firstCreate = Task {
            try await engine.createOptimisticAndQueueIfAbsent(
                modelName: TestRecord.modelName,
                data: ["id": "t1", "title": "Draft", "category": "inbox"]
            ) {
                records.find { $0.category == "inbox" }?.id
            }
        }

        #expect(await waitUntil { await gate.isWaiting })

        let repeatedId = try await engine.createOptimisticAndQueueIfAbsent(
            modelName: TestRecord.modelName,
            data: ["id": "t2", "title": "Draft", "category": "inbox"]
        ) {
            records.find { $0.category == "inbox" }?.id
        }

        #expect(repeatedId == "t1")
        #expect(records.values.map(\.id) == ["t1"])

        await gate.open()
        #expect(try await firstCreate.value == "t1")
        #expect(await storage.getOutbox().count == 1)
    }

    @Test func localOutboxFailureRollsBackOptimisticStateAndHistory() async {
        let storage = MockStorageAdapter()
        storage.beforeAddToOutbox = { _ in throw TestSupportError.storageFailure }
        let transport = MockSyncTransport()
        let modelStore = SyncModelStore()
        modelStore.register(TestRecord.self)
        let engine = SyncEngine(transport: transport, storage: storage, modelStore: modelStore)
        modelStore.set(modelName: TestRecord.modelName, data: [
            "id": "existing",
            "title": "Before",
            "category": "inbox",
        ])

        await #expect(throws: TestSupportError.self) {
            try await engine.createOptimisticAndQueue(
                modelName: TestRecord.modelName,
                data: ["id": "created", "title": "Created", "category": "inbox"]
            )
        }
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "created") == nil)

        await #expect(throws: TestSupportError.self) {
            try await engine.update(
                modelName: TestRecord.modelName,
                id: "existing",
                changes: ["title": "After"]
            )
        }
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "existing")?["title"] as? String == "Before")

        await #expect(throws: TestSupportError.self) {
            try await engine.delete(modelName: TestRecord.modelName, id: "existing")
        }
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "existing") != nil)

        await #expect(throws: TestSupportError.self) {
            try await engine.archive(modelName: TestRecord.modelName, id: "existing")
        }
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "existing")?["archivedAt"] is NSNull)
        #expect(!engine.canUndo)
        #expect(await storage.getOutbox().isEmpty)
    }

    @Test func incompleteMutateResponseRequeuesWholeBatch() async throws {
        let storage = MockStorageAdapter()
        let transport = MockSyncTransport()
        transport.mutateHandler = { batch in
            MutateResult(
                success: true,
                lastSyncId: "2",
                results: [
                    TransactionResult(
                        clientTxId: batch.transactions[0].clientTxId,
                        success: true,
                        syncId: "2",
                        error: nil
                    ),
                ]
            )
        }
        let outbox = OutboxManager(
            storage: storage,
            transport: transport,
            clientId: "client-a",
            batchDelay: 60,
            baseRetryDelay: 60
        )
        _ = try await outbox.insert(modelName: TestRecord.modelName, modelId: "t1", data: ["id": "t1"])
        _ = try await outbox.insert(modelName: TestRecord.modelName, modelId: "t2", data: ["id": "t2"])

        await outbox.flushBatch()

        let stored = await storage.getOutbox()
        #expect(stored.count == 2)
        #expect(stored.allSatisfy { $0.state == .queued })
        #expect(stored.allSatisfy { $0.retryCount == 1 })
    }

    @Test func duplicateMutateResponseIdsRequeueWholeBatch() async throws {
        let storage = MockStorageAdapter()
        let transport = MockSyncTransport()
        transport.mutateHandler = { batch in
            let duplicate = batch.transactions[0].clientTxId
            return MutateResult(
                success: true,
                lastSyncId: "2",
                results: [
                    TransactionResult(clientTxId: duplicate, success: true, syncId: "1", error: nil),
                    TransactionResult(clientTxId: duplicate, success: true, syncId: "2", error: nil),
                ]
            )
        }
        let outbox = OutboxManager(
            storage: storage,
            transport: transport,
            clientId: "client-a",
            batchDelay: 60,
            baseRetryDelay: 60
        )
        _ = try await outbox.insert(modelName: TestRecord.modelName, modelId: "t1", data: ["id": "t1"])
        _ = try await outbox.insert(modelName: TestRecord.modelName, modelId: "t2", data: ["id": "t2"])

        await outbox.flushBatch()

        let stored = await storage.getOutbox()
        #expect(stored.allSatisfy { $0.state == .queued })
        #expect(stored.allSatisfy { $0.retryCount == 1 })
    }

    @Test(arguments: ["", "not-a-number", "-1", "0"])
    func successfulMutateResultRequiresPositiveNumericSyncId(syncId: String) async throws {
        let storage = MockStorageAdapter()
        let transport = MockSyncTransport()
        transport.mutateHandler = { batch in
            MutateResult(
                success: true,
                lastSyncId: "5",
                results: [
                    TransactionResult(
                        clientTxId: batch.transactions[0].clientTxId,
                        success: true,
                        syncId: syncId,
                        error: nil
                    ),
                ]
            )
        }
        let outbox = OutboxManager(
            storage: storage,
            transport: transport,
            clientId: "client-a",
            batchDelay: 60,
            baseRetryDelay: 60
        )
        _ = try await outbox.insert(
            modelName: TestRecord.modelName,
            modelId: "t1",
            data: ["id": "t1"]
        )

        await outbox.flushBatch()

        let stored = await storage.getOutbox()
        #expect(stored.count == 1)
        #expect(stored.first?.state == .queued)
        #expect(stored.first?.retryCount == 1)
        #expect(stored.first?.syncIdNeededForCompletion == nil)
    }

    @Test func transactionsQueuedDuringInFlightSendStillFlush() async throws {
        let storage = MockStorageAdapter()
        let transport = MockSyncTransport()

        var firstSendGate: CheckedContinuation<Void, Never>?
        var gateArmed = true
        transport.mutateHandler = { batch in
            if gateArmed {
                gateArmed = false
                await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                    firstSendGate = continuation
                }
            }
            return MutateResult(
                success: true,
                lastSyncId: "1",
                results: batch.transactions.map {
                    TransactionResult(clientTxId: $0.clientTxId, success: true, syncId: "1", error: nil)
                }
            )
        }

        let outbox = OutboxManager(
            storage: storage,
            transport: transport,
            clientId: "client-a",
            batchDelay: 0.01
        )

        _ = try await outbox.insert(modelName: TestRecord.modelName, modelId: "t1", data: ["id": "t1"])
        // Wait for the first send to be in flight (held open by the gate).
        #expect(await waitUntil { transport.mutateBatches.count == 1 })

        // Queue a second transaction while the first batch is still sending;
        // this used to be dropped until the next unrelated mutation.
        _ = try await outbox.insert(modelName: TestRecord.modelName, modelId: "t2", data: ["id": "t2"])
        try? await Task.sleep(for: .milliseconds(50))
        firstSendGate?.resume()

        #expect(await waitUntil { transport.mutateBatches.count == 2 })
        let secondBatchIds = transport.mutateBatches.last?.transactions.map(\.modelId) ?? []
        #expect(secondBatchIds == ["t2"])
    }

    @Test func processPendingDuringInFlightMutateDoesNotResendLoop() async throws {
        let storage = MockStorageAdapter()
        let transport = MockSyncTransport()

        var firstSendGate: CheckedContinuation<Void, Never>?
        var gateArmed = true
        transport.mutateHandler = { batch in
            if gateArmed {
                gateArmed = false
                await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                    firstSendGate = continuation
                }
            }
            return MutateResult(
                success: true,
                lastSyncId: "10",
                results: batch.transactions.map {
                    TransactionResult(clientTxId: $0.clientTxId, success: true, syncId: "10", error: nil)
                }
            )
        }

        let outbox = OutboxManager(
            storage: storage,
            transport: transport,
            clientId: "client-a",
            batchDelay: 0.01
        )

        _ = try await outbox.insert(modelName: TestRecord.modelName, modelId: "t1", data: ["id": "t1"])
        #expect(await waitUntil { transport.mutateBatches.count == 1 })
        #expect(await waitUntil { firstSendGate != nil })

        // Reconnect while the mutate is still in flight — previously this
        // reset `.sent` → `.queued` and re-enqueued the same batch, causing a
        // dedup storm. It must await the in-flight send instead.
        let processTask = Task { @MainActor in
            try await outbox.processPendingTransactions()
        }

        // Give processPending a moment to reach the in-flight wait.
        try? await Task.sleep(for: .milliseconds(50))
        #expect(transport.mutateBatches.count == 1)

        firstSendGate?.resume()
        try await processTask.value

        // One mutate ack; outbox parked in awaitingSync (no engine cursor).
        #expect(transport.mutateBatches.count == 1)
        let stored = await storage.getOutbox()
        #expect(stored.count == 1)
        #expect(stored.first?.state == .awaitingSync)
        #expect(stored.first?.syncIdNeededForCompletion == "10")

        // A second reconnect must not resend either.
        try await outbox.processPendingTransactions()
        try? await Task.sleep(for: .milliseconds(50))
        #expect(transport.mutateBatches.count == 1)
        #expect(await storage.getOutbox().first?.state == .awaitingSync)
    }

    @Test func transportFailureDoesNotRecursivelyReflush() async throws {
        let storage = MockStorageAdapter()
        let transport = MockSyncTransport()
        transport.mutateHandler = { _ in
            // Non-offline transport error so retryCount bumps and scheduleRetry
            // arms — the bug was recursive flushBatch before that timer fires.
            throw URLError(.badServerResponse)
        }

        // Long retry delay so a single flushBatch cannot be confused with the
        // backoff timer. The old recursive follow-up would stack-overflow /
        // issue many mutates inside one flushBatch call.
        let outbox = OutboxManager(
            storage: storage,
            transport: transport,
            clientId: "client-a",
            batchDelay: 60,
            baseRetryDelay: 60
        )

        _ = try await outbox.insert(modelName: TestRecord.modelName, modelId: "t1", data: ["id": "t1"])
        await outbox.flushBatch()

        #expect(transport.mutateBatches.count == 1)
        let stored = await storage.getOutbox()
        #expect(stored.count == 1)
        #expect(stored.first?.state == .queued)
        #expect(stored.first?.retryCount == 1)

        // Give a brief window: recursion would have fired more mutates already.
        try? await Task.sleep(for: .milliseconds(50))
        #expect(transport.mutateBatches.count == 1)
    }

    @Test func dedupedMutateClearsWhenEngineCursorAlreadyAhead() async throws {
        let storage = MockStorageAdapter()
        let transport = MockSyncTransport()
        transport.mutateHandler = { batch in
            // Server dedup: same clientTxIds already applied at sync id 10.
            MutateResult(
                success: true,
                lastSyncId: "10",
                results: batch.transactions.map {
                    TransactionResult(clientTxId: $0.clientTxId, success: true, syncId: "10", error: nil)
                }
            )
        }

        let outbox = OutboxManager(
            storage: storage,
            transport: transport,
            clientId: "client-a",
            batchDelay: 0.01
        )
        // Engine has already applied sync id 50 via bootstrap/deltas.
        outbox.syncCursorProvider = { "50" }

        _ = try await outbox.insert(modelName: TestRecord.modelName, modelId: "t1", data: ["id": "t1"])
        #expect(await waitUntil { transport.mutateBatches.count == 1 })
        #expect(await waitUntil { await storage.getOutbox().isEmpty })

        // Reconnect must not resurrect or resend the completed transaction.
        try await outbox.processPendingTransactions()
        try? await Task.sleep(for: .milliseconds(50))
        #expect(transport.mutateBatches.count == 1)
        #expect(await storage.getOutbox().isEmpty)
    }

    @Test func offlineMutationsRetryWithoutCountingAgainstMaxRetries() async throws {
        let storage = MockStorageAdapter()
        let transport = MockSyncTransport()

        var offline = true
        transport.mutateHandler = { batch in
            if offline {
                throw URLError(.notConnectedToInternet)
            }
            return MutateResult(
                success: true,
                lastSyncId: "5",
                results: batch.transactions.map {
                    TransactionResult(clientTxId: $0.clientTxId, success: true, syncId: "5", error: nil)
                }
            )
        }

        let outbox = OutboxManager(
            storage: storage,
            transport: transport,
            clientId: "client-a",
            batchDelay: 0.01,
            baseRetryDelay: 0.05
        )

        _ = try await outbox.insert(modelName: TestRecord.modelName, modelId: "t1", data: ["id": "t1"])

        // Offline send happened, transaction back to queued with no retry burn.
        #expect(await waitUntil { transport.mutateBatches.count >= 1 })
        var stored = await storage.getOutbox()
        #expect(stored.first?.state == .queued)
        #expect(stored.first?.retryCount == 0)

        // Connectivity returns: the retry loop must resend without any new
        // mutation or restart.
        offline = false
        #expect(await waitUntil {
            let outboxNow = await storage.getOutbox()
            return outboxNow.first?.state == .awaitingSync
        })
        stored = await storage.getOutbox()
        #expect(stored.first?.syncIdNeededForCompletion == "5")
    }

    @Test func rejectedTransactionRollsBackOptimisticState() async throws {
        let storage = MockStorageAdapter()
        let transport = MockSyncTransport()
        transport.mutateHandler = { batch in
            MutateResult(
                success: false,
                lastSyncId: zeroSyncId,
                results: batch.transactions.map {
                    TransactionResult(clientTxId: $0.clientTxId, success: false, syncId: nil, error: "validation failed")
                }
            )
        }

        let modelStore = SyncModelStore()
        let engine = SyncEngine(transport: transport, storage: storage, modelStore: modelStore)
        engine.register(TestRecord.self)

        // Seed an existing record, then make a rejected update.
        modelStore.set(modelName: TestRecord.modelName, data: ["id": "t1", "title": "before", "category": "c"])
        try await engine.update(modelName: TestRecord.modelName, id: "t1", changes: ["title": "after"])
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "t1")?["title"] as? String == "after")

        #expect(await waitUntil { engine.lastError != nil })
        let title = modelStore.snapshot(modelName: TestRecord.modelName, id: "t1")?["title"] as? String
        #expect(title == "before")
    }

    @Test func rejectedEarlierUpdateReappliesLaterSameModelMutation() async throws {
        let storage = MockStorageAdapter()
        let transport = MockSyncTransport()
        transport.mutateHandler = { batch in
            MutateResult(
                success: false,
                lastSyncId: "5",
                results: [
                    TransactionResult(clientTxId: batch.transactions[0].clientTxId, success: false, syncId: nil, error: "rejected"),
                    TransactionResult(clientTxId: batch.transactions[1].clientTxId, success: true, syncId: "5", error: nil),
                ]
            )
        }
        let modelStore = SyncModelStore()
        let engine = SyncEngine(transport: transport, storage: storage, modelStore: modelStore)
        engine.register(TestRecord.self)
        modelStore.set(modelName: TestRecord.modelName, data: ["id": "t1", "title": "A", "category": "c"])

        try await engine.update(modelName: TestRecord.modelName, id: "t1", changes: ["title": "B"])
        try await Task.sleep(for: .milliseconds(2))
        try await engine.update(modelName: TestRecord.modelName, id: "t1", changes: ["title": "C"])

        #expect(await waitUntil { engine.lastError != nil })
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "t1")?["title"] as? String == "C")
    }

    @Test func accountBoundaryCancellationRequeuesWithoutRetryBurn() async throws {
        let storage = MockStorageAdapter()
        let transport = MockSyncTransport()
        transport.mutateHandler = { _ in
            try await Task.sleep(for: .seconds(30))
            return MutateResult(success: true, lastSyncId: "1", results: [])
        }
        let outbox = OutboxManager(
            storage: storage,
            transport: transport,
            clientId: "client-a",
            batchDelay: 0
        )
        _ = try await outbox.insert(modelName: TestRecord.modelName, modelId: "t1", data: ["id": "t1"])
        #expect(await waitUntil { transport.mutateBatches.count == 1 })

        for expectedSendCount in 2 ... 4 {
            await outbox.resetForAccountBoundary()
            try await outbox.processPendingTransactions()
            #expect(await waitUntil { transport.mutateBatches.count >= expectedSendCount })
        }
        await outbox.resetForAccountBoundary()

        let stored = await storage.getOutbox()
        #expect(stored.first?.state == .queued)
        #expect(stored.first?.retryCount == 0)
    }

    @Test func restartReplaysSameTimestampMutationsInInsertionOrder() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("stratasync-replay-order-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let storage = SQLiteStorage(dbName: "replay", directory: directory)
        try await storage.open()
        let ordered = [
            Transaction(clientTxId: "tx-z-insert", clientId: "client-a", modelName: TestRecord.modelName, modelId: "t1", action: .insert, payload: ["id": "t1"], original: nil, state: .queued, createdAt: 1, retryCount: 0),
            Transaction(clientTxId: "tx-m-update", clientId: "client-a", modelName: TestRecord.modelName, modelId: "t1", action: .update, payload: ["title": "after"], original: ["id": "t1"], state: .queued, createdAt: 1, retryCount: 0),
            Transaction(clientTxId: "tx-a-delete", clientId: "client-a", modelName: TestRecord.modelName, modelId: "t1", action: .delete, payload: [:], original: ["id": "t1", "title": "after"], state: .queued, createdAt: 1, retryCount: 0),
        ]
        for transaction in ordered {
            try await storage.addToOutbox(transaction)
        }
        try await storage.close()
        try await storage.open()

        let transport = MockSyncTransport()
        let outbox = OutboxManager(storage: storage, transport: transport, clientId: "client-a", batchDelay: 0)
        try await outbox.processPendingTransactions()
        #expect(await waitUntil { transport.mutateBatches.count == 1 })
        #expect(transport.mutateBatches[0].transactions.map(\.clientTxId) == ordered.map(\.clientTxId))
        await outbox.resetForAccountBoundary()
        try await storage.close()
    }
}

// MARK: - Orchestrator Tests

@MainActor
@Suite struct OrchestratorResilienceTests {
    @Test func malformedRawDeltaIsRejectedAsAWholeWithoutAdvancingCursor() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "1"))
        try await storage.put(
            modelName: TestRecord.modelName,
            id: "task-1",
            data: ["id": "task-1", "title": "before", "category": "inbox"]
        )
        let transport = MockSyncTransport()
        transport.fetchDeltasHandler = { _, _ in
            try transport.parseDeltaPacket([
                "lastSyncId": "3",
                "actions": [
                    [
                        "syncId": "2",
                        "modelName": TestRecord.modelName,
                        "modelId": "task-1",
                        "action": "U",
                        "data": ["title": "would-apply"],
                    ],
                    [
                        "syncId": "3",
                        "modelName": TestRecord.modelName,
                        "modelId": "task-1",
                        "action": "X",
                        "data": ["title": "unknown-action"],
                    ],
                ],
            ])!
        }
        let (orchestrator, modelStore) = makeOrchestrator(storage: storage, transport: transport)

        await #expect(throws: SyncTransportError.self) {
            try await orchestrator.start(groups: ["ws-1"])
        }

        #expect((await storage.getMeta()).lastSyncId == "1")
        #expect(await storage.get(modelName: TestRecord.modelName, id: "task-1")?["title"] as? String == "before")
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-1")?["title"] as? String == "before")
    }

    /// The parser now trusts the wire, so the orchestrator is the layer that
    /// refuses to *apply* a self-contradictory packet: an action beyond the
    /// watermark would be stored under a cursor that skips straight past it.
    @Test func internallyInconsistentPacketIsRejectedWithoutAdvancingCursor() async throws {
        func update(_ syncId: SyncId, title: String) -> SyncAction {
            SyncAction(
                id: syncId,
                modelName: TestRecord.modelName,
                modelId: "task-1",
                action: .update,
                data: ["title": title],
                groupId: nil,
                groups: nil,
                clientTxId: nil,
                clientId: nil
            )
        }

        let packets: [DeltaPacket] = [
            // An action past the watermark the cursor would advance to.
            DeltaPacket(lastSyncId: "1", actions: [update("2", title: "after")], hasMore: false),
            // Actions out of sequence.
            DeltaPacket(
                lastSyncId: "3",
                actions: [update("3", title: "later"), update("2", title: "earlier")],
                hasMore: false
            ),
        ]

        for packet in packets {
            let storage = MockStorageAdapter()
            try await storage.setMeta(seededMeta(cursor: "1"))
            try await storage.put(
                modelName: TestRecord.modelName,
                id: "task-1",
                data: ["id": "task-1", "title": "before", "category": "inbox"]
            )
            let transport = MockSyncTransport()
            transport.fetchDeltasHandler = { _, _ in packet }
            let (orchestrator, _) = makeOrchestrator(storage: storage, transport: transport)

            await #expect(throws: SyncTransportError.self) {
                try await orchestrator.start(groups: ["ws-1"])
            }
            #expect((await storage.getMeta()).lastSyncId == "1")
            #expect(
                await storage.get(modelName: TestRecord.modelName, id: "task-1")?["title"] as? String == "before"
            )
        }
    }

    /// The parser rejects a watermark it cannot trust. Consistency *between*
    /// the watermark and the actions is not its job — the corpus takes a
    /// supplied `lastSyncId` verbatim and preserves action order as received —
    /// so that check lives in the orchestrator's framing guard, covered by
    /// `internallyInconsistentPacketIsRejectedWithoutAdvancingCursor`.
    @Test func rawDeltaRejectsUnusableSyncIds() {
        let transport = MockSyncTransport()
        let action: [String: Any] = [
            "syncId": "2",
            "modelName": TestRecord.modelName,
            "modelId": "task-1",
            "action": "U",
            "data": ["title": "after"],
        ]

        #expect(throws: SyncTransportError.self) {
            _ = try transport.parseDeltaPacket([
                "lastSyncId": "not-numeric",
                "actions": [action],
            ])
        }
        // A numeric watermark has already lost precision by the time it lands
        // here, so it is rejected rather than stringified into a plausible one.
        #expect(throws: SyncTransportError.self) {
            _ = try transport.parseDeltaPacket([
                "lastSyncId": 42,
                "actions": [action],
            ])
        }
    }

    /// A packet that claims actions and then cannot produce them must not
    /// decode to an empty one: the watermark is taken verbatim, so an empty
    /// packet advances the cursor past deltas that were never applied and are
    /// never refetched. The bare-array shape is deliberately lenient here
    /// (the corpus skips its non-object members) because it derives its
    /// watermark from the actions that survive.
    @Test func malformedActionsAreNeverSilentlyEmptied() throws {
        let transport = MockSyncTransport()

        #expect(throws: SyncTransportError.self) {
            _ = try transport.parseDeltaPacket(["lastSyncId": "9", "actions": "junk"])
        }
        #expect(throws: SyncTransportError.self) {
            _ = try transport.parseDeltaPacket(["lastSyncId": "9", "actions": [NSNull()]])
        }

        let skipped = try transport.parseDeltaPacket([NSNull()])
        #expect(skipped?.actions.isEmpty == true)
        #expect(skipped?.lastSyncId == zeroSyncId)
    }

    /// A payload that is not a delta at all decodes to nil, so an unrecognized
    /// socket frame is ignored instead of taking the connection down.
    @Test func rawDeltaDecodesNonPacketPayloadsToNil() throws {
        let transport = MockSyncTransport()

        #expect(try transport.parseDeltaPacket(42) == nil)
        #expect(try transport.parseDeltaPacket("{}") == nil)
        #expect(try transport.parseDeltaPacket(["foo": "bar"]) == nil)
    }

    @Test func malformedRawBootstrapLineThrowsInsteadOfBeingDropped() {
        let transport = MockSyncTransport()

        #expect(throws: SyncTransportError.self) {
            _ = try transport.parseBootstrapLine("{malformed-json")
        }
        #expect(throws: SyncTransportError.self) {
            _ = try transport.parseBootstrapLine(#"{"unexpected":"object"}"#)
        }
    }

    @Test func ndjsonFramerKeepsUnicodeSeparatorsInsideJSONString() throws {
        let transport = MockSyncTransport()
        let title = "nel\u{0085}line\u{2028}paragraph\u{2029}end"
        let modelLine = "{\"__class\":\"StrictRecord\",\"id\":\"task-1\",\"title\":\"\(title)\"}"
        let metadataLine = "{\"lastSyncId\":\"20\",\"subscribedSyncGroups\":[\"ws-1\"]}"
        let payload = modelLine + "\n" + metadataLine + "\r\n"

        var framer = NDJSONLineFramer()
        var lines: [String] = []
        for byte in payload.utf8 {
            if let line = try framer.append(byte) {
                lines.append(line)
            }
        }
        if let line = try framer.finish() {
            lines.append(line)
        }

        #expect(lines.count == 2)
        if case .model(let modelName, let data) = try transport.parseBootstrapLine(lines[0]) {
            #expect(modelName == "StrictRecord")
            #expect(data["id"] as? String == "task-1")
            #expect(data["title"] as? String == title)
        } else {
            Issue.record("Expected a model bootstrap event")
        }
        if case .metadata(let metadata) = try transport.parseBootstrapLine(lines[1]) {
            #expect(metadata.lastSyncId == "20")
            #expect(metadata.subscribedSyncGroups == ["ws-1"])
        } else {
            Issue.record("Expected a metadata bootstrap event")
        }
    }

    @Test func informationalBootstrapCountDoesNotBlockSnapshotReplacement() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "10"))
        try await storage.put(
            modelName: StrictRecord.modelName,
            id: "task-old",
            data: ["id": "task-old", "title": "old"]
        )
        let transport = MockSyncTransport()
        transport.fetchDeltasHandler = { after, _ in
            if after == "10" {
                throw SyncTransportError.bootstrapRequired
            }
            return DeltaPacket(lastSyncId: after, actions: [], hasMore: false)
        }
        transport.bootstrapEvents = [
            .model(modelName: StrictRecord.modelName, data: ["id": "task-new", "title": "new"]),
            .metadata(BootstrapMetadata(
                lastSyncId: "20",
                subscribedSyncGroups: ["ws-1"],
                returnedModelsCount: [StrictRecord.modelName: 2]
            )),
            .end(rowCount: 1),
        ]
        let modelStore = SyncModelStore()
        modelStore.register(StrictRecord.self)
        let outbox = OutboxManager(storage: storage, transport: transport, clientId: "client-a")
        let orchestrator = SyncOrchestrator(
            storage: storage,
            transport: transport,
            modelStore: modelStore,
            outboxManager: outbox
        )

        try await orchestrator.start(groups: ["ws-1"])

        #expect(await storage.get(modelName: StrictRecord.modelName, id: "task-old") == nil)
        #expect(await storage.get(modelName: StrictRecord.modelName, id: "task-new") != nil)
        #expect((await storage.getMeta()).lastSyncId == "20")
    }

    /// Truncation must preserve the existing snapshot and cursor.
    @Test(arguments: ["missing", "short", "long", "negative", "no-count", "duplicate", "trailing-row"])
    func incompleteBootstrapPreservesSnapshot(ending: String) async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "10"))
        try await storage.put(
            modelName: StrictRecord.modelName,
            id: "task-old",
            data: ["id": "task-old", "title": "old"]
        )
        let transport = MockSyncTransport()
        transport.fetchDeltasHandler = { after, _ in
            if after == "10" {
                throw SyncTransportError.bootstrapRequired
            }
            return DeltaPacket(lastSyncId: after, actions: [], hasMore: false)
        }
        transport.bootstrapEvents = [
            .metadata(BootstrapMetadata(
                lastSyncId: "20",
                subscribedSyncGroups: ["ws-1"],
                returnedModelsCount: [StrictRecord.modelName: 2, "ChildRecord": 3]
            )),
            .model(modelName: StrictRecord.modelName, data: ["id": "task-new", "title": "new"]),
            // Cut here: `ChildRecord` never streams a single row.
        ]
        switch ending {
        case "short": transport.bootstrapEvents.append(.end(rowCount: 0))
        case "long": transport.bootstrapEvents.append(.end(rowCount: 2))
        case "negative": transport.bootstrapEvents.append(.end(rowCount: -1))
        case "no-count": transport.bootstrapEvents.append(.end(rowCount: nil))
        case "duplicate":
            transport.bootstrapEvents.append(contentsOf: [.end(rowCount: 1), .end(rowCount: 1)])
        case "trailing-row":
            transport.bootstrapEvents.append(.end(rowCount: 1))
            transport.bootstrapEvents.append(.model(
                modelName: StrictRecord.modelName, data: ["id": "task-extra", "title": "extra"]
            ))
        default: break
        }
        let modelStore = SyncModelStore()
        modelStore.register(StrictRecord.self)
        let outbox = OutboxManager(storage: storage, transport: transport, clientId: "client-a")
        let orchestrator = SyncOrchestrator(
            storage: storage,
            transport: transport,
            modelStore: modelStore,
            outboxManager: outbox
        )

        await #expect(throws: SyncTransportError.self) {
            try await orchestrator.start(groups: ["ws-1"])
        }

        // The snapshot is fetched before `stateQueue`, so a rejected one leaves
        // the usable local state exactly where it was.
        #expect(await storage.get(modelName: StrictRecord.modelName, id: "task-old") != nil)
        #expect(await storage.get(modelName: StrictRecord.modelName, id: "task-new") == nil)
        #expect((await storage.getMeta()).lastSyncId == "10")
    }

    /// A model the server holds no rows for is not a truncated stream.
    @Test(arguments: [false, true])
    func bootstrapWithAnEmptyModelIsAccepted(allRowsTouched: Bool) async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "10"))
        let transport = MockSyncTransport()
        transport.fetchDeltasHandler = { after, _ in
            if after == "10" {
                throw SyncTransportError.bootstrapRequired
            }
            return DeltaPacket(lastSyncId: after, actions: [], hasMore: false)
        }
        transport.bootstrapEvents = [
            .metadata(BootstrapMetadata(
                lastSyncId: "20",
                subscribedSyncGroups: ["ws-1"],
                returnedModelsCount: [StrictRecord.modelName: 1, "ChildRecord": 0]
            )),
            .model(modelName: StrictRecord.modelName, data: ["id": "task-new", "title": "new"]),
            .end(rowCount: 1),
        ]
        if allRowsTouched {
            transport.bootstrapEvents = [
                .metadata(BootstrapMetadata(
                    lastSyncId: "20", subscribedSyncGroups: ["ws-1"],
                    returnedModelsCount: [StrictRecord.modelName: 1]
                )),
                .end(rowCount: 0),
            ]
        }
        let modelStore = SyncModelStore()
        modelStore.register(StrictRecord.self)
        let outbox = OutboxManager(storage: storage, transport: transport, clientId: "client-a")
        let orchestrator = SyncOrchestrator(
            storage: storage,
            transport: transport,
            modelStore: modelStore,
            outboxManager: outbox
        )

        try await orchestrator.start(groups: ["ws-1"])

        #expect((await storage.get(modelName: StrictRecord.modelName, id: "task-new") != nil) == !allRowsTouched)
        #expect((await storage.getMeta()).lastSyncId == "20")
    }

    private func makeOrchestrator(
        storage: MockStorageAdapter,
        transport: MockSyncTransport
    ) -> (SyncOrchestrator, SyncModelStore) {
        let modelStore = SyncModelStore()
        modelStore.register(TestRecord.self)
        let outbox = OutboxManager(
            storage: storage,
            transport: transport,
            clientId: "client-a",
            batchDelay: 0.01,
            baseRetryDelay: 0.05
        )
        let orchestrator = SyncOrchestrator(
            storage: storage,
            transport: transport,
            modelStore: modelStore,
            outboxManager: outbox
        )
        orchestrator.resubscribeDelay = 0.05
        orchestrator.groupChangeRetryDelay = 0.02
        return (orchestrator, modelStore)
    }

    @Test func groupChangePersistsAndRetriesFailedAuthoritativeReplacement() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "10"))
        try await storage.put(
            modelName: TestRecord.modelName,
            id: "task-private",
            data: ["id": "task-private", "title": "private", "category": "secret"]
        )
        let transport = MockSyncTransport()
        transport.subscribeStreamProvider = { call in
            AsyncThrowingStream { continuation in
                if call == 1 {
                    // Recovery may redeliver an older G after a later allowed
                    // delta advanced the general cursor. It is still an
                    // authoritative invalidation.
                    continuation.yield(DeltaPacket(
                        lastSyncId: "10",
                        actions: [makeAction(
                            syncId: "5",
                            action: .group,
                            data: ["subscribedSyncGroups": ["ws-2"]]
                        )],
                        hasMore: false
                    ))
                }
            }
        }
        transport.bootstrapStreamProvider = {
            if transport.bootstrapCount == 1 {
                return AsyncThrowingStream { continuation in
                    continuation.finish(throwing: URLError(.networkConnectionLost))
                }
            }
            return AsyncThrowingStream { continuation in
                continuation.yield(.metadata(BootstrapMetadata(
                    lastSyncId: "20",
                    subscribedSyncGroups: ["ws-2"]
                )))
                continuation.yield(.end(rowCount: 0))
                continuation.finish()
            }
        }

        let (orchestrator, modelStore) = makeOrchestrator(storage: storage, transport: transport)
        try await orchestrator.start(groups: ["ws-1"])

        #expect(await waitUntil {
            let meta = await storage.getMeta()
            return transport.bootstrapCount >= 1 && meta.groupChangePending
        })
        #expect(transport.bootstrapGroups.first == ["ws-2"])
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-private") == nil)
        #expect(await waitUntil {
            let meta = await storage.getMeta()
            return transport.bootstrapCount == 2 && !meta.groupChangePending
        })
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-private") == nil)
        #expect(await storage.get(modelName: TestRecord.modelName, id: "task-private") == nil)

        await orchestrator.stop()
    }

    @Test func rejectedDeleteCannotRestoreRevokedRowWhilePrivacyBootstrapFails() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "10"))
        let revoked: [String: Any] = [
            "id": "task-private", "title": "private", "category": "secret",
        ]
        try await storage.put(
            modelName: TestRecord.modelName,
            id: "task-private",
            data: revoked
        )
        let transport = MockSyncTransport()
        var subscription: AsyncThrowingStream<DeltaPacket, Error>.Continuation?
        transport.subscribeStreamProvider = { _ in
            AsyncThrowingStream { continuation in
                subscription = continuation
            }
        }
        transport.bootstrapStreamProvider = {
            AsyncThrowingStream { continuation in
                continuation.finish(throwing: URLError(.networkConnectionLost))
            }
        }
        transport.mutateHandler = { batch in
            while !(await storage.getMeta()).groupChangePending {
                try await Task.sleep(for: .milliseconds(2))
            }
            return MutateResult(
                success: false,
                lastSyncId: "10",
                results: batch.transactions.map {
                    TransactionResult(
                        clientTxId: $0.clientTxId,
                        success: false,
                        syncId: nil,
                        error: "access revoked"
                    )
                }
            )
        }

        let modelStore = SyncModelStore()
        let engine = SyncEngine(
            transport: transport,
            storage: storage,
            modelStore: modelStore
        )
        engine.register(TestRecord.self)
        try await engine.start(groups: ["ws-1"])
        try await engine.delete(modelName: TestRecord.modelName, id: "task-private")

        subscription?.yield(DeltaPacket(
            lastSyncId: "11",
            actions: [makeAction(
                syncId: "11",
                action: .group,
                data: ["subscribedSyncGroups": ["ws-1"]]
            )],
            hasMore: false
        ))

        #expect(await waitUntil {
            let meta = await storage.getMeta()
            return transport.bootstrapCount >= 1 && meta.groupChangePending
        })
        #expect(await waitUntil { engine.lastError != nil })
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-private") == nil)
        #expect((await storage.getMeta()).groupChangePending)

        await #expect(throws: SyncEngineError.self) {
            try await engine.create(
                modelName: TestRecord.modelName,
                data: ["id": "during-reconcile", "title": "hidden", "category": "secret"]
            )
        }
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "during-reconcile") == nil)

        subscription?.finish()
        await engine.stop()
    }

    @Test func inFlightRejectedDeleteCannotRestoreRowAfterPrivacyBootstrapSucceeds() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "10"))
        try await storage.put(
            modelName: TestRecord.modelName,
            id: "task-private",
            data: ["id": "task-private", "title": "private", "category": "secret"]
        )
        let transport = MockSyncTransport()
        var subscription: AsyncThrowingStream<DeltaPacket, Error>.Continuation?
        transport.subscribeStreamProvider = { _ in
            AsyncThrowingStream { continuation in
                subscription = continuation
            }
        }
        transport.bootstrapEvents = [
            .metadata(BootstrapMetadata(lastSyncId: "20", subscribedSyncGroups: [])),
            .end(rowCount: 0),
        ]
        let mutationGate = AsyncGate()
        transport.mutateHandler = { batch in
            await mutationGate.wait()
            return MutateResult(
                success: false,
                lastSyncId: "20",
                results: batch.transactions.map {
                    TransactionResult(
                        clientTxId: $0.clientTxId,
                        success: false,
                        syncId: nil,
                        error: "access revoked"
                    )
                }
            )
        }

        let modelStore = SyncModelStore()
        let engine = SyncEngine(
            transport: transport,
            storage: storage,
            modelStore: modelStore
        )
        engine.register(TestRecord.self)
        try await engine.start(groups: ["ws-1"])
        try await engine.delete(modelName: TestRecord.modelName, id: "task-private")
        #expect(await waitUntil { await mutationGate.isWaiting })

        subscription?.yield(DeltaPacket(
            lastSyncId: "11",
            actions: [makeAction(
                syncId: "11",
                action: .group,
                data: ["subscribedSyncGroups": []]
            )],
            hasMore: false
        ))
        #expect(await waitUntil {
            let meta = await storage.getMeta()
            return transport.bootstrapCount == 1 && !meta.groupChangePending
        })

        await mutationGate.open()
        #expect(await waitUntil {
            await storage.getOutbox().isEmpty
        })
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-private") == nil)
        #expect(await storage.get(modelName: TestRecord.modelName, id: "task-private") == nil)

        subscription?.finish()
        await engine.stop()
    }

    @Test func privacyMetadataFailureKeepsRestartHydrationQuarantined() async throws {
        let storage = MockStorageAdapter()
        var recoveryMeta = seededMeta(cursor: "10")
        recoveryMeta.bootstrapComplete = false
        recoveryMeta.lastSyncAt = 1
        // A known revocation is outstanding. A routine re-bootstrap no longer
        // quarantines, so only this latch makes the replacement a privacy one.
        recoveryMeta.groupChangePending = true
        try await storage.setMeta(recoveryMeta)
        try await storage.put(
            modelName: TestRecord.modelName,
            id: "task-server",
            data: ["id": "task-server", "title": "server", "category": "secret"]
        )
        let localInsert = createInsertTransaction(
            clientId: "client-a",
            modelName: TestRecord.modelName,
            modelId: "task-local",
            data: ["id": "task-local", "title": "local", "category": "secret"]
        )
        try await storage.addToOutbox(localInsert)
        var privacyMetadataWriteFailed = false
        storage.beforeSetMeta = { meta in
            if meta.groupChangePending, !meta.privacyWithheldTransactionIds.isEmpty {
                privacyMetadataWriteFailed = true
                throw TestSupportError.storageFailure
            }
        }

        let transport = MockSyncTransport()
        transport.bootstrapEvents = [
            .metadata(BootstrapMetadata(lastSyncId: "20", subscribedSyncGroups: [])),
            .end(rowCount: 0),
        ]
        transport.mutateHandler = { _ in throw URLError(.notConnectedToInternet) }
        let (orchestrator, modelStore) = makeOrchestrator(storage: storage, transport: transport)
        await #expect(throws: TestSupportError.self) {
            try await orchestrator.start(groups: ["ws-1"])
        }
        #expect(privacyMetadataWriteFailed)
        #expect((await storage.getMeta()).groupChangePending)
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-local") == nil)
        await orchestrator.stop()

        let restartTransport = MockSyncTransport()
        restartTransport.bootstrapEvents = transport.bootstrapEvents
        restartTransport.mutateHandler = transport.mutateHandler
        let (restarted, restartedStore) = makeOrchestrator(
            storage: storage,
            transport: restartTransport
        )
        await #expect(throws: TestSupportError.self) {
            try await restarted.start(groups: ["ws-1"])
        }
        #expect(restartedStore.snapshot(modelName: TestRecord.modelName, id: "task-local") == nil)
        #expect((await storage.getMeta()).groupChangePending)
        await restarted.stop()
    }

    @Test func privacyReplacementKeepsMissingInsertsDurableButHidden() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "10"))
        try await storage.put(
            modelName: TestRecord.modelName,
            id: "task-revoked",
            data: ["id": "task-revoked", "title": "private", "category": "secret"]
        )
        let revokedDelete = createDeleteTransaction(
            clientId: "client-a",
            modelName: TestRecord.modelName,
            modelId: "task-revoked",
            original: ["id": "task-revoked", "title": "private", "category": "secret"]
        )
        let localInsert = createInsertTransaction(
            clientId: "client-a",
            modelName: TestRecord.modelName,
            modelId: "task-local",
            data: ["id": "task-local", "title": "local", "category": "inbox"]
        )
        let localUpdate = createUpdateTransaction(
            clientId: "client-a",
            modelName: TestRecord.modelName,
            modelId: "task-local",
            changes: ["title": "local edited"],
            original: ["title": "local"]
        )
        try await storage.addToOutbox(revokedDelete)
        try await storage.addToOutbox(localInsert)
        try await storage.addToOutbox(localUpdate)

        let transport = MockSyncTransport()
        transport.subscribeStreamProvider = { call in
            AsyncThrowingStream { continuation in
                if call == 1 {
                    continuation.yield(DeltaPacket(
                        lastSyncId: "11",
                        actions: [makeAction(
                            syncId: "11",
                            action: .group,
                            data: ["subscribedSyncGroups": ["ws-1"]]
                        )],
                        hasMore: false
                    ))
                }
            }
        }
        transport.bootstrapEvents = [
            .model(modelName: TestRecord.modelName, data: [
                "id": "task-authorized", "title": "allowed", "category": "inbox",
            ]),
            .metadata(BootstrapMetadata(lastSyncId: "20", subscribedSyncGroups: ["ws-1"])),
            .end(rowCount: 1),
        ]
        transport.mutateHandler = { _ in throw URLError(.notConnectedToInternet) }

        let (orchestrator, modelStore) = makeOrchestrator(storage: storage, transport: transport)
        try await orchestrator.start(groups: ["ws-1"])
        #expect(await waitUntil { transport.bootstrapCount == 1 && orchestrator.lastSyncId == "20" })

        let pending = await storage.getOutbox()
        #expect(pending.first { $0.clientTxId == revokedDelete.clientTxId }?.original == nil)
        #expect(pending.first { $0.clientTxId == localInsert.clientTxId }?.payload["title"] as? String == "local")
        #expect(pending.first { $0.clientTxId == localUpdate.clientTxId }?.original == nil)
        #expect((await storage.getMeta()).privacyWithheldTransactionIds.contains(localInsert.clientTxId))
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-revoked") == nil)
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-local") == nil)

        await orchestrator.stop()

        let restartedTransport = MockSyncTransport()
        restartedTransport.mutateHandler = { _ in throw URLError(.notConnectedToInternet) }
        let (restarted, restartedStore) = makeOrchestrator(
            storage: storage,
            transport: restartedTransport
        )
        try await restarted.start(groups: ["ws-1"])
        #expect(restartedStore.snapshot(modelName: TestRecord.modelName, id: "task-authorized") != nil)
        #expect(restartedStore.snapshot(modelName: TestRecord.modelName, id: "task-local") == nil)
        #expect(await storage.getOutbox().contains { $0.clientTxId == localInsert.clientTxId })
        await restarted.stop()
    }

    @Test func catchUpFollowsHasMorePagination() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "1"))
        try await storage.put(modelName: TestRecord.modelName, id: "task-1", data: ["id": "task-1", "title": "t0", "category": "c0"])

        let transport = MockSyncTransport()
        transport.fetchDeltasHandler = { after, _ in
            switch after {
            case "1":
                return DeltaPacket(
                    lastSyncId: "3",
                    actions: [
                        makeAction(syncId: "2", data: ["title": "t2"]),
                        makeAction(syncId: "3", data: ["category": "c3"]),
                    ],
                    hasMore: true
                )
            case "3":
                return DeltaPacket(
                    lastSyncId: "4",
                    actions: [makeAction(syncId: "4", data: ["sortOrder": 4])],
                    hasMore: false
                )
            default:
                return DeltaPacket(lastSyncId: after, actions: [], hasMore: false)
            }
        }

        let (orchestrator, modelStore) = makeOrchestrator(storage: storage, transport: transport)
        try await orchestrator.start(groups: ["ws-1"])

        #expect(transport.fetchDeltasCursors == ["1", "3"])
        #expect(orchestrator.lastSyncId == "4")
        let snapshot = modelStore.snapshot(modelName: TestRecord.modelName, id: "task-1")
        #expect(snapshot?["title"] as? String == "t2")
        #expect(snapshot?["category"] as? String == "c3")
        #expect(snapshot?["sortOrder"] as? Double == 4)

        await orchestrator.stop()
    }

    @Test func localDataReadyFiresAfterHydrationBeforeCatchUpCompletes() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "1"))
        try await storage.put(modelName: TestRecord.modelName, id: "task-1", data: ["id": "task-1", "title": "t0", "category": "c0"])

        let transport = MockSyncTransport()
        var catchUpGate: CheckedContinuation<Void, Never>?
        transport.fetchDeltasHandler = { after, _ in
            guard after == "1" else {
                return DeltaPacket(lastSyncId: after, actions: [], hasMore: false)
            }
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                catchUpGate = continuation
            }
            return DeltaPacket(lastSyncId: after, actions: [], hasMore: false)
        }

        let (orchestrator, modelStore) = makeOrchestrator(storage: storage, transport: transport)
        var sawLocalDataReady = false
        orchestrator.onEvent = { event in
            if case .localDataReady = event {
                sawLocalDataReady = true
            }
        }

        let startTask = Task {
            try await orchestrator.start(groups: ["ws-1"])
        }

        #expect(await waitUntil { sawLocalDataReady })
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-1")?["title"] as? String == "t0")
        #expect(transport.fetchDeltasCursors == ["1"])

        catchUpGate?.resume()
        try await startTask.value
        await orchestrator.stop()
    }

    @Test func restartingSubscriptionKeepsHydratedStoreAndAvoidsBootstrappingState() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "1"))
        try await storage.put(modelName: TestRecord.modelName, id: "task-1", data: ["id": "task-1", "title": "t0", "category": "c0"])

        let transport = MockSyncTransport()
        let (orchestrator, modelStore) = makeOrchestrator(storage: storage, transport: transport)
        var states: [SyncClientState] = []
        orchestrator.onStateChange = { state in
            states.append(state)
        }

        try await orchestrator.start(groups: ["ws-1"])
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-1")?["title"] as? String == "t0")
        #expect(transport.fetchDeltasCursors == ["1"])
        #expect(transport.subscribeCursors == ["1"])

        states.removeAll()
        await orchestrator.restartSubscription()

        #expect(states.isEmpty)
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-1")?["title"] as? String == "t0")
        #expect(transport.fetchDeltasCursors == ["1", "1"])
        #expect(transport.subscribeCursors == ["1", "1"])

        await orchestrator.stop()
    }

    @Test func liveDeltasBufferUntilCatchUpCompletes() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "1"))
        try await storage.put(modelName: TestRecord.modelName, id: "task-1", data: ["id": "task-1", "title": "t0", "category": "c0"])

        let transport = MockSyncTransport()
        // Live packet with a HIGHER syncId arrives immediately on subscribe…
        transport.subscribeStreamProvider = { _ in
            AsyncThrowingStream { continuation in
                continuation.yield(DeltaPacket(
                    lastSyncId: "5",
                    actions: [makeAction(syncId: "5", data: ["title": "t5"])],
                    hasMore: false
                ))
            }
        }
        // …while catch-up (slower) returns the intermediate deltas.
        transport.fetchDeltasHandler = { after, _ in
            try? await Task.sleep(for: .milliseconds(100))
            guard after == "1" else {
                return DeltaPacket(lastSyncId: after, actions: [], hasMore: false)
            }
            return DeltaPacket(
                lastSyncId: "4",
                actions: [
                    makeAction(syncId: "2", data: ["title": "t2"]),
                    makeAction(syncId: "3", data: ["category": "c3"]),
                    makeAction(syncId: "4", data: ["sortOrder": 4]),
                ],
                hasMore: false
            )
        }

        let (orchestrator, modelStore) = makeOrchestrator(storage: storage, transport: transport)
        try await orchestrator.start(groups: ["ws-1"])

        #expect(await waitUntil { orchestrator.lastSyncId == "5" })
        let snapshot = modelStore.snapshot(modelName: TestRecord.modelName, id: "task-1")
        // Without the replay barrier, the live syncId-5 packet advances the
        // cursor and deltas 2-4 get filtered out, losing these fields.
        #expect(snapshot?["category"] as? String == "c3")
        #expect(snapshot?["sortOrder"] as? Double == 4)
        #expect(snapshot?["title"] as? String == "t5")

        await orchestrator.stop()
    }

    @Test func multiPageCatchUpAppliesAsOneBatchedWrite() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "1"))
        try await storage.put(
            modelName: TestRecord.modelName,
            id: "task-seed",
            data: ["id": "task-seed", "title": "seed", "category": "c"]
        )

        let pageSize = 25
        let pageCount = 4
        let finalSyncId = pageCount * pageSize + 1
        let transport = MockSyncTransport()
        // Page p covers syncIds (p*25+2 ... p*25+26) and reports lastSyncId
        // p*25+26, so the next cursor derives the next page.
        transport.fetchDeltasHandler = { after, _ in
            let page = ((Int(after) ?? 1) - 1) / pageSize
            guard page < pageCount else {
                return DeltaPacket(lastSyncId: after, actions: [], hasMore: false)
            }
            let base = page * pageSize + 1
            let actions = (1...pageSize).map { i -> SyncAction in
                let syncId = base + i
                return makeAction(
                    syncId: String(syncId),
                    modelId: "task-\(syncId)",
                    action: .insert,
                    data: ["id": "task-\(syncId)", "title": "t\(syncId)", "category": "c"]
                )
            }
            return DeltaPacket(
                lastSyncId: String(base + pageSize),
                actions: actions,
                hasMore: page + 1 < pageCount
            )
        }

        let (orchestrator, modelStore) = makeOrchestrator(storage: storage, transport: transport)
        // The seeded row is written before the orchestrator starts.
        let rowWritesBeforeStart = storage.rowWriteCalls
        try await orchestrator.start(groups: ["ws-1"])

        #expect(await waitUntil { orchestrator.lastSyncId == String(finalSyncId) })

        // All four pages collapse into one batched write, so the UI lands on
        // final state instead of stepping through each page — and no per-action
        // row writes remain.
        #expect(storage.writeBatchCalls == 1)
        #expect(storage.rowWriteCalls == rowWritesBeforeStart)
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-2") != nil)
        #expect(
            modelStore.snapshot(
                modelName: TestRecord.modelName,
                id: "task-\(finalSyncId)"
            ) != nil
        )

        await orchestrator.stop()
    }

    @Test func staleCursorTriggersFullRebootstrapPreservingOutbox() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "10"))
        try await storage.put(modelName: TestRecord.modelName, id: "task-old", data: ["id": "task-old", "title": "old", "category": "c"])
        let pendingTx = createInsertTransaction(
            clientId: "client-a",
            modelName: TestRecord.modelName,
            modelId: "task-pending",
            data: ["id": "task-pending", "title": "pending", "category": "c"]
        )
        try await storage.addToOutbox(pendingTx)
        let pendingDelete = createDeleteTransaction(
            clientId: "client-a",
            modelName: TestRecord.modelName,
            modelId: "task-old",
            original: ["id": "task-old", "title": "old", "category": "c"]
        )
        try await storage.addToOutbox(pendingDelete)

        let transport = MockSyncTransport()
        transport.fetchDeltasHandler = { after, _ in
            if after == "10" {
                throw SyncTransportError.bootstrapRequired
            }
            return DeltaPacket(lastSyncId: after, actions: [], hasMore: false)
        }
        transport.bootstrapEvents = [
            .model(modelName: TestRecord.modelName, data: ["id": "task-new", "title": "new", "category": "c"]),
            .metadata(BootstrapMetadata(lastSyncId: "42", subscribedSyncGroups: ["ws-1"])),
            .end(rowCount: 1),
        ]
        transport.mutateHandler = { _ in throw URLError(.notConnectedToInternet) }

        let (orchestrator, modelStore) = makeOrchestrator(storage: storage, transport: transport)
        try await orchestrator.start(groups: ["ws-1"])

        #expect(transport.bootstrapCount == 1)
        #expect(orchestrator.lastSyncId == "42")
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-new") != nil)
        // The pending outbox transaction must survive the re-bootstrap.
        let outboxAfter = await storage.getOutbox()
        #expect(outboxAfter.contains { $0.clientTxId == pendingTx.clientTxId })
        // A stale cursor is not a known revocation: pending work is replayed
        // over the new snapshot exactly as after a first bootstrap, not
        // withheld or stripped of its rollback state.
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-pending") != nil)
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-old") == nil)
        let metaAfter = await storage.getMeta()
        #expect(metaAfter.privacyWithheldTransactionIds.isEmpty)
        #expect(!metaAfter.groupChangePending)
        #expect(outboxAfter.first { $0.clientTxId == pendingDelete.clientTxId }?.original != nil)

        await orchestrator.stop()
    }

    @Test func interruptedBootstrapPreservesLastGoodSnapshotAndOutbox() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "10"))
        try await storage.put(
            modelName: TestRecord.modelName,
            id: "task-old",
            data: ["id": "task-old", "title": "old", "category": "inbox"]
        )
        let pending = createInsertTransaction(
            clientId: "client-a",
            modelName: TestRecord.modelName,
            modelId: "task-pending",
            data: ["id": "task-pending", "title": "pending", "category": "inbox"]
        )
        try await storage.addToOutbox(pending)

        let transport = MockSyncTransport()
        transport.fetchDeltasHandler = { _, _ in throw SyncTransportError.bootstrapRequired }
        transport.bootstrapStreamProvider = {
            AsyncThrowingStream { continuation in
                continuation.yield(.model(
                    modelName: TestRecord.modelName,
                    data: ["id": "task-new", "title": "partial", "category": "inbox"]
                ))
                continuation.finish(throwing: URLError(.networkConnectionLost))
            }
        }
        let (orchestrator, modelStore) = makeOrchestrator(storage: storage, transport: transport)

        await #expect(throws: URLError.self) {
            try await orchestrator.start(groups: ["ws-1"])
        }

        #expect(await storage.get(modelName: TestRecord.modelName, id: "task-old") != nil)
        #expect(await storage.get(modelName: TestRecord.modelName, id: "task-new") == nil)
        #expect((await storage.getMeta()).lastSyncId == "10")
        #expect(await storage.getOutbox().contains { $0.clientTxId == pending.clientTxId })
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-old") != nil)
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-new") == nil)
    }

    @Test func malformedBootstrapRecordDoesNotReplaceSnapshotOrCursor() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "10"))
        try await storage.put(
            modelName: StrictRecord.modelName,
            id: "task-old",
            data: ["id": "task-old", "title": "old"]
        )
        let transport = MockSyncTransport()
        transport.fetchDeltasHandler = { _, _ in throw SyncTransportError.bootstrapRequired }
        transport.bootstrapEvents = [
            .model(modelName: StrictRecord.modelName, data: ["id": "task-new", "title": 42]),
            .metadata(BootstrapMetadata(lastSyncId: "20", subscribedSyncGroups: ["ws-1"])),
            .end(rowCount: 1),
        ]
        let modelStore = SyncModelStore()
        modelStore.register(StrictRecord.self)
        let outbox = OutboxManager(storage: storage, transport: transport, clientId: "client-a")
        let orchestrator = SyncOrchestrator(
            storage: storage,
            transport: transport,
            modelStore: modelStore,
            outboxManager: outbox
        )

        await #expect(throws: SyncModelStoreError.self) {
            try await orchestrator.start(groups: ["ws-1"])
        }

        #expect(await storage.get(modelName: StrictRecord.modelName, id: "task-old") != nil)
        #expect(await storage.get(modelName: StrictRecord.modelName, id: "task-new") == nil)
        #expect((await storage.getMeta()).lastSyncId == "10")
    }

    @Test func malformedDeltaDoesNotPersistOrAdvanceCursor() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "1"))
        try await storage.put(
            modelName: StrictRecord.modelName,
            id: "task-1",
            data: ["id": "task-1", "title": "before"]
        )
        let transport = MockSyncTransport()
        transport.fetchDeltasHandler = { after, _ in
            DeltaPacket(
                lastSyncId: "2",
                actions: [
                    SyncAction(
                        id: "2",
                        modelName: StrictRecord.modelName,
                        modelId: "task-1",
                        action: .update,
                        data: ["title": 42],
                        groupId: nil,
                        groups: nil,
                        clientTxId: nil,
                        clientId: nil
                    ),
                ],
                hasMore: false
            )
        }
        let modelStore = SyncModelStore()
        modelStore.register(StrictRecord.self)
        let outbox = OutboxManager(storage: storage, transport: transport, clientId: "client-a")
        let orchestrator = SyncOrchestrator(
            storage: storage,
            transport: transport,
            modelStore: modelStore,
            outboxManager: outbox
        )

        await #expect(throws: SyncModelStoreError.self) {
            try await orchestrator.start(groups: ["ws-1"])
        }

        #expect((await storage.getMeta()).lastSyncId == "1")
        #expect(await storage.get(modelName: StrictRecord.modelName, id: "task-1")?["title"] as? String == "before")
        #expect(modelStore.snapshot(modelName: StrictRecord.modelName, id: "task-1")?["title"] as? String == "before")
    }

    @Test func deadSubscriptionRestartsFromCurrentCursor() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "7"))
        try await storage.put(modelName: TestRecord.modelName, id: "task-1", data: ["id": "task-1", "title": "t0", "category": "c0"])

        let transport = MockSyncTransport()
        transport.subscribeStreamProvider = { callIndex in
            if callIndex == 1 {
                // First subscription delivers one delta then dies (e.g. the
                // transport exhausted its reconnect attempts).
                return AsyncThrowingStream { continuation in
                    continuation.yield(DeltaPacket(
                        lastSyncId: "9",
                        actions: [makeAction(syncId: "9", data: ["title": "t9"])],
                        hasMore: false
                    ))
                    Task {
                        try? await Task.sleep(for: .milliseconds(50))
                        continuation.finish(throwing: SyncTransportError.maxReconnectAttemptsReached)
                    }
                }
            }
            return AsyncThrowingStream { _ in }
        }

        let (orchestrator, _) = makeOrchestrator(storage: storage, transport: transport)
        try await orchestrator.start(groups: ["ws-1"])

        // The orchestrator must start a second subscription on its own, and it
        // must resume from the advanced cursor, not the original one.
        #expect(await waitUntil { transport.subscribeCursors.count >= 2 })
        #expect(transport.subscribeCursors.first == "7")
        #expect(transport.subscribeCursors.last == "9")

        await orchestrator.stop()
    }
}
