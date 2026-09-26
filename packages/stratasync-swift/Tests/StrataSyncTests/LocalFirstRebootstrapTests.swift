import Foundation
import Testing
@testable import StrataSync

/// Local-first guarantees around re-bootstraps and group changes:
///
/// 1. Cached rows the user is still authorized for stay visible at launch and
///    throughout sync, online or offline.
/// 2. Once the client knows access was revoked, the pre-revocation rows stay
///    hidden, across relaunches too.
/// 3. A snapshot replacement is all-or-nothing on disk.
@MainActor
@Suite(.serialized)
struct LocalFirstRebootstrapTests {
    // MARK: Routine re-bootstrap

    /// A schema-hash re-bootstrap after an app update whose local apply fails
    /// (standing in for the process dying mid-replacement) must leave the old
    /// snapshot visible, and a relaunch must hydrate it with no network.
    @Test func relaunchAfterFailedRoutineRebootstrapHydratesOldRows() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        // Launch 1: first install bootstraps under schema v1.
        let firstStorage = FaultInjectingStorage(directory: directory)
        let firstTransport = MockSyncTransport()
        firstTransport.bootstrapEvents = snapshot(lastSyncId: "10", groups: ["ws-1"], ids: ["task-old"])
        let (firstEngine, firstStore) = makeEngine(
            storage: firstStorage,
            transport: firstTransport,
            schemaHash: "schema-v1"
        )
        try await firstEngine.ensureAccountReady("account-a")
        #expect(firstStore.snapshot(modelName: TestRecord.modelName, id: "task-old") != nil)
        await firstEngine.stop()

        // Launch 2: the app update ships schema v2, so the start re-bootstraps.
        // The replacement never commits.
        let secondStorage = FaultInjectingStorage(directory: directory)
        secondStorage.failReplaceSnapshot = true
        let secondTransport = MockSyncTransport()
        secondTransport.bootstrapEvents = snapshot(lastSyncId: "20", groups: ["ws-1"], ids: ["task-new"])
        let (secondEngine, secondStore) = makeEngine(
            storage: secondStorage,
            transport: secondTransport,
            schemaHash: "schema-v2"
        )
        let secondEvents = EventLog()
        secondEngine.onEvent = secondEvents.record

        await #expect(throws: TestSupportError.self) {
            try await secondEngine.ensureAccountReady("account-a")
        }
        #expect(secondTransport.bootstrapCount == 1)
        #expect(secondStore.snapshot(modelName: TestRecord.modelName, id: "task-old") != nil)
        #expect(secondEngine.isLocalDataReady)
        #expect(!(await secondStorage.getMeta()).groupChangePending)
        #expect(secondEvents.labels == [
            "localHydration(storage,1)",
            "bootstrapStarted(schemaHash)",
            "bootstrapFailed(schemaHash)",
        ])
        await secondEngine.stop()

        // Launch 3: offline. The old rows must come straight back from disk.
        let thirdStorage = FaultInjectingStorage(directory: directory)
        let thirdTransport = MockSyncTransport()
        thirdTransport.bootstrapStreamProvider = {
            AsyncThrowingStream { $0.finish(throwing: URLError(.notConnectedToInternet)) }
        }
        let (thirdEngine, thirdStore) = makeEngine(
            storage: thirdStorage,
            transport: thirdTransport,
            schemaHash: "schema-v2"
        )
        let thirdEvents = EventLog()
        thirdEngine.onEvent = thirdEvents.record

        try await thirdEngine.resetForAccount("account-a")
        #expect(thirdEngine.isLocalDataReady)
        #expect(thirdStore.snapshot(modelName: TestRecord.modelName, id: "task-old") != nil)
        #expect(thirdEvents.labels == ["localHydration(storage,1)"])
        await thirdEngine.stop()
    }

    /// While a routine replacement downloads, the store keeps the old rows,
    /// then swaps to the new ones in one step with pending work replayed.
    @Test func routineRebootstrapSwapsRowsWithoutClearingOrWithholdingPendingWork() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "10", authoritativeGroups: ["ws-1"]))
        try await storage.put(modelName: TestRecord.modelName, id: "task-old", data: row("task-old"))
        let pendingInsert = createInsertTransaction(
            clientId: "client-a",
            modelName: TestRecord.modelName,
            modelId: "task-pending",
            data: row("task-pending")
        )
        try await storage.addToOutbox(pendingInsert)

        let gate = Gate()
        let transport = MockSyncTransport()
        transport.fetchDeltasHandler = { after, _ in
            if after == "10" { throw SyncTransportError.bootstrapRequired }
            return DeltaPacket(lastSyncId: after, actions: [], hasMore: false)
        }
        transport.bootstrapStreamProvider = gatedSnapshot(
            gate: gate,
            events: snapshot(lastSyncId: "42", groups: ["ws-1"], ids: ["task-new"])
        )
        transport.mutateHandler = { _ in throw URLError(.notConnectedToInternet) }

        let (orchestrator, modelStore) = makeOrchestrator(storage: storage, transport: transport)
        let events = EventLog()
        orchestrator.onEvent = events.record
        let startTask = Task { try await orchestrator.start(groups: []) }

        #expect(await waitUntil { await gate.isWaiting })
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-old") != nil)
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-pending") != nil)
        #expect(!(await storage.getMeta()).groupChangePending)

        await gate.open()
        try await startTask.value

        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-old") == nil)
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-new") != nil)
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-pending") != nil)
        let meta = await storage.getMeta()
        #expect(meta.privacyWithheldTransactionIds.isEmpty)
        #expect(!meta.groupChangePending)
        #expect(events.labels.filter(\.isLifecycle) == [
            "bootstrapStarted(cursorTooOld)",
            "bootstrapFinished(cursorTooOld,1)",
        ])
        await orchestrator.stop()
    }

    /// A routine replacement that drops a row must not let a rejected pending
    /// update restore it from `original`, while a local insert and its
    /// follow-up update still replay. Nothing is latched or cleared.
    @Test func routineRebootstrapWithholdsPendingUpdateToRowMissingFromSnapshot() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "10", authoritativeGroups: ["ws-1"]))
        try await storage.put(modelName: TestRecord.modelName, id: "task-gone", data: row("task-gone"))
        try await storage.put(modelName: TestRecord.modelName, id: "task-kept", data: row("task-kept"))
        let goneUpdate = createUpdateTransaction(
            clientId: "client-a",
            modelName: TestRecord.modelName,
            modelId: "task-gone",
            changes: ["title": "edited offline"],
            original: ["title": "task-gone"]
        )
        let localInsert = createInsertTransaction(
            clientId: "client-a",
            modelName: TestRecord.modelName,
            modelId: "task-local",
            data: row("task-local")
        )
        let localUpdate = createUpdateTransaction(
            clientId: "client-a",
            modelName: TestRecord.modelName,
            modelId: "task-local",
            changes: ["title": "local edited"],
            original: ["title": "task-local"]
        )
        try await storage.addToOutbox(goneUpdate)
        try await storage.addToOutbox(localInsert)
        try await storage.addToOutbox(localUpdate)

        let transport = MockSyncTransport()
        transport.fetchDeltasHandler = { after, _ in
            if after == "10" { throw SyncTransportError.bootstrapRequired }
            return DeltaPacket(lastSyncId: after, actions: [], hasMore: false)
        }
        transport.bootstrapEvents = snapshot(lastSyncId: "42", groups: ["ws-1"], ids: ["task-kept"])
        transport.mutateHandler = { batch in
            MutateResult(
                success: false,
                lastSyncId: "43",
                results: batch.transactions.map {
                    TransactionResult(
                        clientTxId: $0.clientTxId,
                        success: $0.clientTxId != goneUpdate.clientTxId,
                        syncId: $0.clientTxId == goneUpdate.clientTxId ? nil : "43",
                        error: $0.clientTxId == goneUpdate.clientTxId ? "not found" : nil
                    )
                }
            )
        }

        let (engine, modelStore) = makeEngine(storage: storage, transport: transport, schemaHash: "")
        let events = EventLog()
        engine.onEvent = events.record
        try await engine.start(groups: [])

        #expect(transport.bootstrapCount == 1)
        #expect(await waitUntil {
            !(await storage.getOutbox().contains { $0.clientTxId == goneUpdate.clientTxId })
        })
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-gone") == nil)
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-kept") != nil)
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-local")?["title"] as? String
            == "local edited")
        let meta = await storage.getMeta()
        #expect(meta.privacyWithheldTransactionIds.contains(goneUpdate.clientTxId))
        #expect(!meta.privacyWithheldTransactionIds.contains(localInsert.clientTxId))
        #expect(!meta.privacyWithheldTransactionIds.contains(localUpdate.clientTxId))
        #expect(!meta.groupChangePending)
        #expect(!events.labels.contains { $0.hasPrefix("quarantine") })
        await engine.stop()
    }

    // MARK: Group changes

    /// Access only added: rows stay visible, nothing durable is latched, and
    /// the re-bootstrap then brings in the new group's rows.
    @Test func additionOnlyGroupChangeKeepsRowsVisibleAndAddsNewGroupRows() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "10", authoritativeGroups: ["ws-1"]))
        try await storage.put(modelName: TestRecord.modelName, id: "task-1", data: row("task-1"))

        let gate = Gate()
        let transport = MockSyncTransport()
        transport.subscribeStreamProvider = { call in
            AsyncThrowingStream { continuation in
                guard call == 1 else { return }
                continuation.yield(groupChangePacket(syncId: "11", groups: ["ws-1", "ws-2"]))
                // A later packet must not move the cursor past the group action
                // before its bootstrap lands.
                continuation.yield(DeltaPacket(
                    lastSyncId: "12",
                    actions: [SyncAction(
                        id: "12",
                        modelName: TestRecord.modelName,
                        modelId: "task-1",
                        action: .update,
                        data: ["title": "later"],
                        groupId: nil,
                        groups: nil,
                        clientTxId: nil,
                        clientId: nil
                    )],
                    hasMore: false
                ))
            }
        }
        transport.bootstrapStreamProvider = gatedSnapshot(
            gate: gate,
            events: snapshot(lastSyncId: "20", groups: ["ws-1", "ws-2"], ids: ["task-1", "task-2"])
        )

        let (orchestrator, modelStore) = makeOrchestrator(storage: storage, transport: transport)
        let events = EventLog()
        orchestrator.onEvent = events.record
        try await orchestrator.start(groups: [])

        #expect(await waitUntil { await gate.isWaiting })
        #expect(transport.bootstrapGroups.last == ["ws-1", "ws-2"])
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-1")?["title"] as? String == "task-1")
        #expect(!orchestrator.isGroupChangeReconcilePending)
        #expect(orchestrator.lastSyncId == "10")
        let midMeta = await storage.getMeta()
        #expect(!midMeta.groupChangePending)
        #expect(midMeta.lastSyncId == "10")

        // A relaunch at this point hydrates the cached rows.
        let (relaunched, relaunchedStore) = makeOrchestrator(storage: storage, transport: MockSyncTransport())
        _ = try await relaunched.hydrateSelectedAccount()
        #expect(relaunchedStore.snapshot(modelName: TestRecord.modelName, id: "task-1") != nil)

        await gate.open()
        #expect(await waitUntil {
            modelStore.snapshot(modelName: TestRecord.modelName, id: "task-2") != nil
        })
        #expect(await waitUntil { orchestrator.lastSyncId == "20" })
        let meta = await storage.getMeta()
        #expect(!meta.groupChangePending)
        #expect(meta.authoritativeGroups == ["ws-1", "ws-2"])
        #expect(await storage.get(modelName: TestRecord.modelName, id: "task-2") != nil)
        #expect(!events.labels.contains { $0.hasPrefix("quarantine") })
        #expect(events.labels.contains("bootstrapStarted(groupChange)"))
        #expect(await waitUntil { events.labels.contains("bootstrapFinished(groupChange,2)") })
        await orchestrator.stop()
    }

    /// Access removed: the existing durable quarantine is unchanged, including
    /// across a relaunch while the replacement cannot be fetched.
    @Test func removalGroupChangeQuarantinesDurablyAcrossRelaunch() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "10", authoritativeGroups: ["ws-1", "ws-2"]))
        try await storage.put(modelName: TestRecord.modelName, id: "task-private", data: row("task-private"))

        let transport = MockSyncTransport()
        transport.subscribeStreamProvider = { call in
            AsyncThrowingStream { continuation in
                if call == 1 {
                    continuation.yield(groupChangePacket(syncId: "11", groups: ["ws-1"]))
                }
            }
        }
        transport.bootstrapStreamProvider = {
            AsyncThrowingStream { $0.finish(throwing: URLError(.notConnectedToInternet)) }
        }

        let (orchestrator, modelStore) = makeOrchestrator(storage: storage, transport: transport)
        let events = EventLog()
        orchestrator.onEvent = events.record
        try await orchestrator.start(groups: [])

        #expect(await waitUntil {
            await storage.getMeta().groupChangePending && transport.bootstrapCount >= 1
        })
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-private") == nil)
        #expect(orchestrator.isGroupChangeReconcilePending)
        #expect(events.labels.contains("quarantineEntered(groupRemoved)"))
        #expect(await waitUntil { events.labels.contains("bootstrapFailed(groupChange)") })
        await orchestrator.stop()

        let (relaunched, relaunchedStore) = makeOrchestrator(storage: storage, transport: MockSyncTransport())
        let relaunchEvents = EventLog()
        relaunched.onEvent = relaunchEvents.record
        let hydrated = try await relaunched.hydrateSelectedAccount()
        #expect(hydrated.meta.groupChangePending)
        #expect(relaunchedStore.snapshot(modelName: TestRecord.modelName, id: "task-private") == nil)
        #expect(relaunchEvents.labels == ["localHydration(quarantined,0)"])
    }

    enum UnknownGroupSet: String, CaseIterable {
        /// The snapshot predates recording authoritative groups.
        case previousSetUnknown
        /// The group action carries no `subscribedSyncGroups`.
        case payloadMissingGroups
    }

    /// Without both sets a removal cannot be ruled out, so it quarantines.
    @Test(arguments: UnknownGroupSet.allCases)
    func unknownGroupSetStillQuarantines(_ unknown: UnknownGroupSet) async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(
            cursor: "10",
            authoritativeGroups: unknown == .previousSetUnknown ? nil : ["ws-1"]
        ))
        try await storage.put(modelName: TestRecord.modelName, id: "task-1", data: row("task-1"))

        let transport = MockSyncTransport()
        transport.subscribeStreamProvider = { call in
            AsyncThrowingStream { continuation in
                guard call == 1 else { return }
                continuation.yield(groupChangePacket(
                    syncId: "11",
                    groups: unknown == .payloadMissingGroups ? nil : ["ws-1", "ws-2"]
                ))
            }
        }
        transport.bootstrapStreamProvider = {
            AsyncThrowingStream { $0.finish(throwing: URLError(.notConnectedToInternet)) }
        }

        let (orchestrator, modelStore) = makeOrchestrator(storage: storage, transport: transport)
        let events = EventLog()
        orchestrator.onEvent = events.record
        try await orchestrator.start(groups: [])

        #expect(await waitUntil { await storage.getMeta().groupChangePending })
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-1") == nil)
        #expect(events.labels.contains("quarantineEntered(groupUnknown)"))
        await orchestrator.stop()
    }

    /// Hosts that pass their own groups overwrite `subscribedGroups`; a group
    /// change must still be judged against the bootstrap's authoritative set.
    @Test func hostRequestedGroupsDoNotMaskARemoval() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "10", authoritativeGroups: ["ws-1", "ws-2"]))
        try await storage.put(modelName: TestRecord.modelName, id: "task-1", data: row("task-1"))

        let transport = MockSyncTransport()
        transport.subscribeStreamProvider = { call in
            AsyncThrowingStream { continuation in
                if call == 1 {
                    // ws-2 revoked, ws-3 added: a superset of the host's ["ws-1"].
                    continuation.yield(groupChangePacket(syncId: "11", groups: ["ws-1", "ws-3"]))
                }
            }
        }
        transport.bootstrapStreamProvider = {
            AsyncThrowingStream { $0.finish(throwing: URLError(.notConnectedToInternet)) }
        }

        let (orchestrator, modelStore) = makeOrchestrator(storage: storage, transport: transport)
        try await orchestrator.start(groups: ["ws-1"])

        #expect(await waitUntil { await storage.getMeta().groupChangePending })
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-1") == nil)
        await orchestrator.stop()
    }

    // MARK: Events

    @Test func quarantineClearsWithBootstrapEventsOnceTheReplacementCommits() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(seededMeta(cursor: "10", authoritativeGroups: ["ws-1", "ws-2"]))
        try await storage.put(modelName: TestRecord.modelName, id: "task-private", data: row("task-private"))

        let transport = MockSyncTransport()
        transport.subscribeStreamProvider = { call in
            AsyncThrowingStream { continuation in
                if call == 1 {
                    continuation.yield(groupChangePacket(syncId: "11", groups: ["ws-1"]))
                }
            }
        }
        transport.bootstrapEvents = snapshot(lastSyncId: "20", groups: ["ws-1"], ids: ["task-kept"])

        let (orchestrator, modelStore) = makeOrchestrator(storage: storage, transport: transport)
        let events = EventLog()
        orchestrator.onEvent = events.record
        try await orchestrator.start(groups: [])

        #expect(await waitUntil { events.labels.contains("quarantineCleared") })
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-kept") != nil)
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-private") == nil)
        #expect(!(await storage.getMeta()).groupChangePending)
        #expect(events.labels.filter(\.isLifecycle) == [
            "quarantineEntered(groupRemoved)",
            "bootstrapStarted(groupChange)",
            "bootstrapFinished(groupChange,1)",
            "quarantineCleared",
        ])
        await orchestrator.stop()
    }

    @Test func firstLaunchReportsAnInitialBootstrap() async throws {
        let storage = MockStorageAdapter()
        let transport = MockSyncTransport()
        transport.bootstrapEvents = snapshot(lastSyncId: "5", groups: ["ws-1"], ids: ["a", "b"])
        let (orchestrator, _) = makeOrchestrator(storage: storage, transport: transport)
        let events = EventLog()
        orchestrator.onEvent = events.record

        try await orchestrator.start(groups: [])

        #expect(events.labels.filter(\.isLifecycle) == [
            "bootstrapStarted(initial)",
            "bootstrapFinished(initial,2)",
        ])
        guard case .bootstrapFinished(_, let durationMs, _) = events.events.first(where: {
            if case .bootstrapFinished = $0 { return true }
            return false
        }) else {
            Issue.record("missing bootstrapFinished")
            return
        }
        #expect(durationMs >= 0)
        #expect((await storage.getMeta()).authoritativeGroups == ["ws-1"])
        await orchestrator.stop()
    }

    // MARK: Storage

    @Test func sqliteRoundTripsAuthoritativeGroups() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let storage = SQLiteStorage(dbName: "meta", directory: directory)
        try await storage.open()

        var meta = seededMeta(cursor: "3", authoritativeGroups: ["ws-1", "ws-2"])
        try await storage.replaceSnapshot(records: [], meta: meta)
        #expect(await storage.getMeta().authoritativeGroups == ["ws-1", "ws-2"])

        meta.authoritativeGroups = nil
        try await storage.setMeta(meta)
        #expect(await storage.getMeta().authoritativeGroups == nil)
        try await storage.close()
    }
}

// MARK: - Helpers

private extension String {
    /// Event labels this suite asserts in order (excludes hydration).
    var isLifecycle: Bool {
        hasPrefix("bootstrap") || hasPrefix("quarantine")
    }
}

@MainActor
private final class EventLog {
    private(set) var events: [SyncClientEvent] = []

    var labels: [String] {
        events.compactMap { event in
            switch event {
            case .bootstrapStarted(let reason):
                "bootstrapStarted(\(reason.rawValue))"
            case .bootstrapFinished(let reason, _, let recordCount):
                "bootstrapFinished(\(reason.rawValue),\(recordCount))"
            case .bootstrapFailed(let reason, _):
                "bootstrapFailed(\(reason.rawValue))"
            case .quarantineEntered(let reason):
                "quarantineEntered(\(reason.rawValue))"
            case .quarantineCleared:
                "quarantineCleared"
            case .localHydration(let outcome, let rowCount):
                "localHydration(\(outcome.rawValue),\(rowCount))"
            default:
                nil
            }
        }
    }

    func record(_ event: SyncClientEvent) {
        events.append(event)
    }
}

private actor Gate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var opened = false
    private(set) var isWaiting = false

    func wait() async {
        guard !opened else { return }
        isWaiting = true
        await withCheckedContinuation { continuation = $0 }
    }

    func open() {
        opened = true
        continuation?.resume()
        continuation = nil
        isWaiting = false
    }
}

/// Delegates to real SQLite so a "relaunch" reopens the same database file,
/// with an injectable failure at the snapshot commit.
private final class FaultInjectingStorage: AccountScopedStorageAdapter, @unchecked Sendable {
    private let base: SQLiteStorage
    var failReplaceSnapshot = false

    init(directory: URL) {
        base = SQLiteStorage(accountScopedDBName: "sync", legacyOwnershipRules: [], directory: directory)
    }

    func selectAccount(_ accountId: String?) async throws { try await base.selectAccount(accountId) }
    func open() async throws { try await base.open() }
    func close() async throws { try await base.close() }
    func get(modelName: String, id: String) async -> [String: Any]? { await base.get(modelName: modelName, id: id) }
    func getAll(modelName: String) async -> [[String: Any]] { await base.getAll(modelName: modelName) }
    func put(modelName: String, id: String, data: [String: Any]) async throws {
        try await base.put(modelName: modelName, id: id, data: data)
    }
    func delete(modelName: String, id: String) async throws { try await base.delete(modelName: modelName, id: id) }
    func writeBatch(_ ops: [BatchOperation]) async throws { try await base.writeBatch(ops) }
    func getMeta() async -> StorageMeta { await base.getMeta() }
    func setMeta(_ meta: StorageMeta) async throws { try await base.setMeta(meta) }
    func getOutbox() async -> [Transaction] { await base.getOutbox() }
    func addToOutbox(_ tx: Transaction) async throws { try await base.addToOutbox(tx) }
    func removeFromOutbox(clientTxId: String) async throws { try await base.removeFromOutbox(clientTxId: clientTxId) }
    func updateOutboxTransaction(clientTxId: String, updates: (inout Transaction) -> Void) async throws {
        try await base.updateOutboxTransaction(clientTxId: clientTxId, updates: updates)
    }
    func replaceSnapshot(records: [StoredModelRecord], meta: StorageMeta) async throws {
        if failReplaceSnapshot { throw TestSupportError.storageFailure }
        try await base.replaceSnapshot(records: records, meta: meta)
    }
    func clear(preserveOutbox: Bool) async throws { try await base.clear(preserveOutbox: preserveOutbox) }
}

@MainActor
private func makeEngine(
    storage: StorageAdapter,
    transport: MockSyncTransport,
    schemaHash: String
) -> (SyncEngine, SyncModelStore) {
    let modelStore = SyncModelStore()
    let engine = SyncEngine(
        transport: transport,
        storage: storage,
        modelStore: modelStore,
        schemaHash: schemaHash
    )
    engine.register(TestRecord.self)
    return (engine, modelStore)
}

@MainActor
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

@MainActor
private func waitUntil(timeout: TimeInterval = 3, _ condition: () async -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return await condition()
}

private func row(_ id: String) -> [String: Any] {
    ["id": id, "title": id, "category": "inbox"]
}

private func snapshot(lastSyncId: SyncId, groups: [String], ids: [String]) -> [BootstrapEvent] {
    ids.map { BootstrapEvent.model(modelName: TestRecord.modelName, data: row($0)) }
        + [
            .metadata(BootstrapMetadata(lastSyncId: lastSyncId, subscribedSyncGroups: groups)),
            .end(rowCount: ids.count),
        ]
}

private func gatedSnapshot(
    gate: Gate,
    events: [BootstrapEvent]
) -> () -> AsyncThrowingStream<BootstrapEvent, Error> {
    {
        AsyncThrowingStream { continuation in
            Task {
                await gate.wait()
                for event in events {
                    continuation.yield(event)
                }
                continuation.finish()
            }
        }
    }
}

private func groupChangePacket(syncId: SyncId, groups: [String]?) -> DeltaPacket {
    DeltaPacket(
        lastSyncId: syncId,
        actions: [SyncAction(
            id: syncId,
            modelName: "SyncGroup",
            modelId: "user-1",
            action: .group,
            data: groups.map { ["subscribedSyncGroups": $0] } ?? [:],
            groupId: nil,
            groups: nil,
            clientTxId: nil,
            clientId: nil
        )],
        hasMore: false
    )
}

private func seededMeta(cursor: SyncId, authoritativeGroups: [String]?) -> StorageMeta {
    StorageMeta(
        lastSyncId: cursor,
        firstSyncId: cursor,
        subscribedGroups: authoritativeGroups ?? ["ws-1"],
        clientId: "client-a",
        bootstrapComplete: true,
        authoritativeGroups: authoritativeGroups
    )
}

private func makeTemporaryDirectory() throws -> URL {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("stratasync-local-first-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
}
