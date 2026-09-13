import Foundation
import Testing
@testable import StrataSync

// MARK: - Shared helpers (file-private; the SyncResilienceTests copies are
// private to that file, so these do not collide).

@MainActor
private func waitUntil(
    timeout: TimeInterval = 3,
    _ condition: () async -> Bool
) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return await condition()
}

/// Actor-based continuation gate. Storage hooks may run off the main actor, so
/// the gate must be reachable from any isolation.
private actor ParityGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var opened = false
    private(set) var isWaiting = false

    func wait() async {
        // If open() already fired, don't park — this defends against a lost
        // resume when open() races ahead of wait().
        if opened { return }
        isWaiting = true
        await withCheckedContinuation { self.continuation = $0 }
    }

    func open() {
        opened = true
        continuation?.resume()
        continuation = nil
        isWaiting = false
    }
}

private func parityAction(
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

private func parityMeta(
    cursor: SyncId,
    clientId: String = "client-a",
    schemaHash: String? = nil,
    bootstrapComplete: Bool = true
) -> StorageMeta {
    StorageMeta(
        lastSyncId: cursor,
        firstSyncId: cursor,
        subscribedGroups: ["ws-1"],
        clientId: clientId,
        bootstrapComplete: bootstrapComplete,
        schemaHash: schemaHash
    )
}

@MainActor
private func makeParityOrchestrator(
    storage: MockStorageAdapter,
    transport: MockSyncTransport,
    clientSchemaHash: String = ""
) -> (SyncOrchestrator, SyncModelStore) {
    let modelStore = SyncModelStore()
    modelStore.register(TestRecord.self)
    let outbox = OutboxManager(
        storage: storage,
        transport: transport,
        clientId: "client-a",
        batchDelay: 0.01,
        baseRetryDelay: 0.02
    )
    let orchestrator = SyncOrchestrator(
        storage: storage,
        transport: transport,
        modelStore: modelStore,
        outboxManager: outbox,
        clientSchemaHash: clientSchemaHash
    )
    orchestrator.resubscribeDelay = 0.05
    return (orchestrator, modelStore)
}

// MARK: - P0-1: transport failures never reject (no lost saves)

@MainActor
@Suite struct RetryPolicyParityTests {
    @Test func transientTransportErrorsRequeueIndefinitelyWithoutRejection() async throws {
        let storage = MockStorageAdapter()
        let transport = MockSyncTransport()
        var attempts = 0
        // Fail more times than the previous maxRetries cap (5) to prove the cap
        // is gone: the transaction must still eventually succeed, never reject.
        transport.mutateHandler = { batch in
            attempts += 1
            if attempts <= 6 {
                throw SyncTransportError.httpError(statusCode: 503)
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
            batchDelay: 0.005,
            baseRetryDelay: 0.005
        )
        var rejected = false
        outbox.onTransactionRejected = { _ in rejected = true }

        _ = try await outbox.insert(modelName: TestRecord.modelName, modelId: "t1", data: ["id": "t1"])

        #expect(await waitUntil(timeout: 5) {
            await storage.getOutbox().first?.state == .awaitingSync
        })
        #expect(!rejected)
        let stored = await storage.getOutbox()
        #expect(stored.count == 1)
        #expect(stored.first?.retryCount == 6)
        #expect(stored.first?.state == .awaitingSync)
    }

    @Test func missingTokenErrorsStayQueuedWithoutRejection() async throws {
        let storage = MockStorageAdapter()
        let transport = MockSyncTransport()
        transport.mutateHandler = { _ in throw SyncTransportError.noToken }
        let outbox = OutboxManager(
            storage: storage,
            transport: transport,
            clientId: "client-a",
            batchDelay: 0.005,
            baseRetryDelay: 0.005
        )
        var rejected = false
        outbox.onTransactionRejected = { _ in rejected = true }

        _ = try await outbox.insert(modelName: TestRecord.modelName, modelId: "t1", data: ["id": "t1"])

        // Several retries fire; the transaction never rejects and never drops.
        #expect(await waitUntil { transport.mutateBatches.count >= 3 })
        #expect(!rejected)
        #expect(await storage.getOutbox().first?.state == .queued)
        #expect(await outbox.getPendingCount() == 1)
    }

    @Test func perTransactionServerRejectionStillRollsBack() async throws {
        // The one remaining rejection path: an explicit per-tx success=false.
        let storage = MockStorageAdapter()
        let transport = MockSyncTransport()
        transport.mutateHandler = { batch in
            MutateResult(
                success: false,
                lastSyncId: zeroSyncId,
                results: batch.transactions.map {
                    TransactionResult(clientTxId: $0.clientTxId, success: false, syncId: nil, error: "rejected")
                }
            )
        }
        let modelStore = SyncModelStore()
        let engine = SyncEngine(transport: transport, storage: storage, modelStore: modelStore)
        engine.register(TestRecord.self)
        modelStore.set(modelName: TestRecord.modelName, data: ["id": "t1", "title": "before", "category": "c"])

        try await engine.update(modelName: TestRecord.modelName, id: "t1", changes: ["title": "after"])
        #expect(await waitUntil { engine.lastError != nil })
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "t1")?["title"] as? String == "before")
        #expect(engine.pendingCount == 0)
    }
}

// MARK: - P0-2: mutation/delta serialization

@MainActor
@Suite struct StateQueueSerializationTests {
    /// A delta injected while a mutation's outbox persist is suspended must not
    /// run until the persist completes, so it never clobbers the optimistic
    /// value and its rebase sees the in-flight transaction.
    @Test func deltaWaitsForSuspendedMutationPersist() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(parityMeta(cursor: "1"))
        try await storage.put(
            modelName: TestRecord.modelName,
            id: "task-1",
            data: ["id": "task-1", "title": "before", "category": "cat0"]
        )
        let transport = MockSyncTransport()
        // A valid send result (the default mock returns lastSyncId "0", which
        // would fail validation and requeue). The transaction stays in the
        // outbox awaiting a sync that never arrives in this test.
        transport.mutateHandler = { batch in
            MutateResult(
                success: true,
                lastSyncId: "9",
                results: batch.transactions.map {
                    TransactionResult(clientTxId: $0.clientTxId, success: true, syncId: "9", error: nil)
                }
            )
        }
        var deltaContinuation: AsyncThrowingStream<DeltaPacket, Error>.Continuation?
        transport.subscribeStreamProvider = { _ in
            AsyncThrowingStream { deltaContinuation = $0 }
        }

        let modelStore = SyncModelStore()
        let records = modelStore.register(TestRecord.self)
        let engine = SyncEngine(transport: transport, storage: storage, modelStore: modelStore)
        try await engine.start(groups: ["ws-1"])

        let gate = ParityGate()
        storage.beforeAddToOutbox = { _ in await gate.wait() }

        let updateTask = Task {
            try await engine.update(
                modelName: TestRecord.modelName,
                id: "task-1",
                changes: ["title": "optimistic"]
            )
        }

        #expect(await waitUntil { await gate.isWaiting })
        // Optimistic value is visible before the durable persist finishes.
        #expect(records.get("task-1")?.title == "optimistic")

        // Inject a delta for the same record (different field) while the persist
        // is suspended. It must block on the state queue.
        deltaContinuation?.yield(DeltaPacket(
            lastSyncId: "2",
            actions: [parityAction(syncId: "2", data: ["category": "server-cat"])],
            hasMore: false
        ))
        try await Task.sleep(for: .milliseconds(30))
        // Still blocked: the delta cannot apply while the mutation holds the lock.
        #expect(records.get("task-1")?.category == "cat0")

        await gate.open()
        try await updateTask.value

        // Delta applied after the mutation; optimistic value never clobbered and
        // the transaction reached the durable outbox (so rebase saw it).
        #expect(await waitUntil { records.get("task-1")?.category == "server-cat" })
        #expect(records.get("task-1")?.title == "optimistic")
        #expect(await storage.getOutbox().contains { $0.modelId == "task-1" })

        await engine.stop()
    }

    /// A mutation started while a delta's storage write is suspended must wait
    /// for the delta; the final state is server data with the optimistic change
    /// layered on top.
    @Test func mutationWaitsForInFlightDelta() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(parityMeta(cursor: "1"))
        try await storage.put(
            modelName: TestRecord.modelName,
            id: "task-1",
            data: ["id": "task-1", "title": "before", "category": "cat0"]
        )
        let transport = MockSyncTransport()
        transport.mutateHandler = { batch in
            MutateResult(
                success: true,
                lastSyncId: "9",
                results: batch.transactions.map {
                    TransactionResult(clientTxId: $0.clientTxId, success: true, syncId: "9", error: nil)
                }
            )
        }
        var deltaContinuation: AsyncThrowingStream<DeltaPacket, Error>.Continuation?
        transport.subscribeStreamProvider = { _ in
            AsyncThrowingStream { deltaContinuation = $0 }
        }

        let modelStore = SyncModelStore()
        let records = modelStore.register(TestRecord.self)
        let engine = SyncEngine(transport: transport, storage: storage, modelStore: modelStore)
        try await engine.start(groups: ["ws-1"])

        let gate = ParityGate()
        var putGateArmed = true
        storage.beforePut = { _, _, _ in
            if putGateArmed {
                putGateArmed = false
                await gate.wait()
            }
        }

        // Delta in flight, suspended mid-write while holding the state lock.
        deltaContinuation?.yield(DeltaPacket(
            lastSyncId: "2",
            actions: [parityAction(syncId: "2", data: ["category": "server-cat"])],
            hasMore: false
        ))
        #expect(await waitUntil { await gate.isWaiting })

        let updateTask = Task {
            try await engine.update(
                modelName: TestRecord.modelName,
                id: "task-1",
                changes: ["title": "optimistic"]
            )
        }

        // The mutation's optimistic write is inside the lock, so it is deferred
        // until the delta releases: the title still reads the server value.
        try await Task.sleep(for: .milliseconds(30))
        #expect(records.get("task-1")?.title == "before")

        await gate.open()
        try await updateTask.value

        #expect(await waitUntil { records.get("task-1")?.title == "optimistic" })
        #expect(records.get("task-1")?.category == "server-cat")

        await engine.stop()
    }
}

// MARK: - Additive optimistic APIs

@MainActor
@Suite struct OptimisticApiParityTests {
    @Test func updateOptimisticAndQueueIsVisibleBeforePersistAndLands() async throws {
        let storage = MockStorageAdapter()
        let gate = ParityGate()
        storage.beforeAddToOutbox = { _ in await gate.wait() }
        let transport = MockSyncTransport()
        let modelStore = SyncModelStore()
        let records = modelStore.register(TestRecord.self)
        let engine = SyncEngine(transport: transport, storage: storage, modelStore: modelStore)
        modelStore.set(modelName: TestRecord.modelName, data: ["id": "t1", "title": "before", "category": "c"])

        let task = engine.updateOptimisticAndQueue(
            modelName: TestRecord.modelName,
            id: "t1",
            changes: ["title": "after"]
        )
        // Visible synchronously, before the durable enqueue is awaited.
        #expect(records.get("t1")?.title == "after")

        // Wait until the persist is parked on the gate before releasing it, so
        // the resume can't be lost to a race.
        #expect(await waitUntil { await gate.isWaiting })
        #expect(await storage.getOutbox().isEmpty)

        await gate.open()
        try await task?.value
        #expect(await storage.getOutbox().count == 1)
    }

    @Test func updateOptimisticAndQueueRollsBackOnEnqueueFailure() async {
        let storage = MockStorageAdapter()
        storage.beforeAddToOutbox = { _ in throw TestSupportError.storageFailure }
        let transport = MockSyncTransport()
        let modelStore = SyncModelStore()
        let records = modelStore.register(TestRecord.self)
        let engine = SyncEngine(transport: transport, storage: storage, modelStore: modelStore)
        modelStore.set(modelName: TestRecord.modelName, data: ["id": "t1", "title": "before", "category": "c"])

        let task = engine.updateOptimisticAndQueue(
            modelName: TestRecord.modelName,
            id: "t1",
            changes: ["title": "after"]
        )
        await #expect(throws: TestSupportError.self) {
            try await task?.value
        }
        #expect(records.get("t1")?.title == "before")
        #expect(await storage.getOutbox().isEmpty)
    }

    @Test func createOptimisticIfAbsentInsertsAndPersists() async throws {
        let storage = MockStorageAdapter()
        let transport = MockSyncTransport()
        let modelStore = SyncModelStore()
        let records = modelStore.register(TestRecord.self)
        let engine = SyncEngine(transport: transport, storage: storage, modelStore: modelStore)

        let result = try engine.createOptimisticIfAbsent(
            modelName: TestRecord.modelName,
            data: ["id": "t1", "title": "Draft", "category": "inbox"],
            existingId: { nil }
        )
        // Optimistic insert visible before the persistence task is awaited.
        #expect(records.get("t1")?.title == "Draft")
        #expect(result.id == "t1")

        try await result.persistence.value
        #expect(await storage.getOutbox().count == 1)
    }

    @Test func createOptimisticIfAbsentSkipsWhenReuseHit() async throws {
        let storage = MockStorageAdapter()
        let transport = MockSyncTransport()
        let modelStore = SyncModelStore()
        let records = modelStore.register(TestRecord.self)
        let engine = SyncEngine(transport: transport, storage: storage, modelStore: modelStore)
        modelStore.set(modelName: TestRecord.modelName, data: ["id": "existing", "title": "Keep", "category": "inbox"])

        let result = try engine.createOptimisticIfAbsent(
            modelName: TestRecord.modelName,
            data: ["id": "t1", "title": "Draft", "category": "inbox"],
            existingId: { "existing" }
        )
        #expect(result.id == "existing")
        try await result.persistence.value

        // No new record, no queued transaction.
        #expect(records.get("t1") == nil)
        #expect(records.values.map(\.id) == ["existing"])
        #expect(await storage.getOutbox().isEmpty)
    }

    @Test func createOptimisticIfAbsentRollsBackOnEnqueueFailure() async {
        let storage = MockStorageAdapter()
        storage.beforeAddToOutbox = { _ in throw TestSupportError.storageFailure }
        let transport = MockSyncTransport()
        let modelStore = SyncModelStore()
        let records = modelStore.register(TestRecord.self)
        let engine = SyncEngine(transport: transport, storage: storage, modelStore: modelStore)

        let result = try? engine.createOptimisticIfAbsent(
            modelName: TestRecord.modelName,
            data: ["id": "t1", "title": "Draft", "category": "inbox"],
            existingId: { nil }
        )
        #expect(records.get("t1")?.title == "Draft")
        await #expect(throws: TestSupportError.self) {
            try await result?.persistence.value
        }
        #expect(records.get("t1") == nil)
        #expect(await storage.getOutbox().isEmpty)
    }
}

// MARK: - P1-3: schema-hash bootstrap

@MainActor
@Suite struct SchemaHashBootstrapTests {
    private func seed(_ storage: MockStorageAdapter, schemaHash: String?) async throws {
        try await storage.setMeta(parityMeta(cursor: "10", schemaHash: schemaHash))
        try await storage.put(
            modelName: TestRecord.modelName,
            id: "task-old",
            data: ["id": "task-old", "title": "old", "category": "c"]
        )
    }

    private func bootstrappingTransport() -> MockSyncTransport {
        let transport = MockSyncTransport()
        transport.fetchDeltasHandler = { after, _ in
            DeltaPacket(lastSyncId: after, actions: [], hasMore: false)
        }
        transport.bootstrapEvents = [
            .model(modelName: TestRecord.modelName, data: ["id": "task-new", "title": "new", "category": "c"]),
            .metadata(BootstrapMetadata(lastSyncId: "42", subscribedSyncGroups: ["ws-1"])),
            .end(rowCount: 1),
        ]
        return transport
    }

    @Test func mismatchedHashForcesFullBootstrap() async throws {
        let storage = MockStorageAdapter()
        try await seed(storage, schemaHash: "old-hash")
        let transport = bootstrappingTransport()
        let (orchestrator, modelStore) = makeParityOrchestrator(
            storage: storage,
            transport: transport,
            clientSchemaHash: "new-hash"
        )

        try await orchestrator.start(groups: ["ws-1"])

        #expect(transport.bootstrapCount == 1)
        #expect(orchestrator.lastSyncId == "42")
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-new") != nil)
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-old") == nil)
        // Bootstrap persists the client's hash for the next launch's comparison.
        #expect((await storage.getMeta()).schemaHash == "new-hash")

        await orchestrator.stop()
    }

    @Test func emptyStoredHashForcesBootstrapWhenClientHashSet() async throws {
        let storage = MockStorageAdapter()
        try await seed(storage, schemaHash: nil)
        let transport = bootstrappingTransport()
        let (orchestrator, _) = makeParityOrchestrator(
            storage: storage,
            transport: transport,
            clientSchemaHash: "v1"
        )

        try await orchestrator.start(groups: ["ws-1"])

        #expect(transport.bootstrapCount == 1)
        #expect((await storage.getMeta()).schemaHash == "v1")

        await orchestrator.stop()
    }

    @Test func matchingHashHydratesWithoutBootstrap() async throws {
        let storage = MockStorageAdapter()
        try await seed(storage, schemaHash: "v1")
        let transport = MockSyncTransport()
        transport.fetchDeltasHandler = { after, _ in
            DeltaPacket(lastSyncId: after, actions: [], hasMore: false)
        }
        let (orchestrator, modelStore) = makeParityOrchestrator(
            storage: storage,
            transport: transport,
            clientSchemaHash: "v1"
        )

        try await orchestrator.start(groups: ["ws-1"])

        #expect(transport.bootstrapCount == 0)
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-old") != nil)

        await orchestrator.stop()
    }

    @Test func emptyClientHashPreservesHydrateBehavior() async throws {
        // The default empty client hash must not force a bootstrap.
        let storage = MockStorageAdapter()
        try await seed(storage, schemaHash: nil)
        let transport = MockSyncTransport()
        transport.fetchDeltasHandler = { after, _ in
            DeltaPacket(lastSyncId: after, actions: [], hasMore: false)
        }
        let (orchestrator, modelStore) = makeParityOrchestrator(
            storage: storage,
            transport: transport,
            clientSchemaHash: ""
        )

        try await orchestrator.start(groups: ["ws-1"])

        #expect(transport.bootstrapCount == 0)
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-old") != nil)

        await orchestrator.stop()
    }

    private func makeEngine(
        storage: MockStorageAdapter,
        transport: MockSyncTransport,
        schemaHash: String
    ) -> (SyncEngine, SyncModelStore) {
        let modelStore = SyncModelStore()
        modelStore.register(TestRecord.self)
        let engine = SyncEngine(
            transport: transport,
            storage: storage,
            modelStore: modelStore,
            clientId: "client-a",
            schemaHash: schemaHash
        )
        return (engine, modelStore)
    }

    @Test func schemaHashRebootstrapAllowsCreateDuringBootstrapDownload() async throws {
        let storage = MockStorageAdapter()
        try await seed(storage, schemaHash: "old-hash")
        let fetchGate = ParityGate()
        let transport = MockSyncTransport()
        transport.fetchDeltasHandler = { after, _ in
            DeltaPacket(lastSyncId: after, actions: [], hasMore: false)
        }
        transport.mutateHandler = { _ in throw URLError(.notConnectedToInternet) }
        transport.bootstrapStreamProvider = {
            AsyncThrowingStream { continuation in
                let task = Task {
                    await fetchGate.wait()
                    continuation.yield(.model(
                        modelName: TestRecord.modelName,
                        data: ["id": "task-new", "title": "new", "category": "c"]
                    ))
                    continuation.yield(.metadata(BootstrapMetadata(
                        lastSyncId: "42",
                        subscribedSyncGroups: ["ws-1"]
                    )))
                    continuation.yield(.end(rowCount: 1))
                    continuation.finish()
                }
                continuation.onTermination = { _ in task.cancel() }
            }
        }
        let (engine, modelStore) = makeEngine(
            storage: storage,
            transport: transport,
            schemaHash: "new-hash"
        )

        let startTask = Task { @MainActor in
            try await engine.start(groups: ["ws-1"])
        }

        let bootstrapFetchStarted = await waitUntil {
            guard transport.bootstrapCount == 1 else { return false }
            return await fetchGate.isWaiting
        }
        #expect(bootstrapFetchStarted)

        let createTask = Task { @MainActor in
            try await engine.createOptimisticAndQueue(
                modelName: TestRecord.modelName,
                data: ["id": "task-created", "title": "draft", "category": "inbox"]
            )
        }
        let createdDuringFetch = await waitUntil {
            modelStore.snapshot(modelName: TestRecord.modelName, id: "task-created") != nil
        }
        #expect(createdDuringFetch)
        // Still downloading — the create did not wait for the stream.
        let stillDownloadingAfterCreate = await fetchGate.isWaiting
        #expect(stillDownloadingAfterCreate)
        #expect(transport.bootstrapCount == 1)
        if createdDuringFetch {
            try await createTask.value
            let outboxHasCreate = await storage.getOutbox().contains { $0.modelId == "task-created" }
            #expect(outboxHasCreate)
            let stillDownloadingAfterPersist = await fetchGate.isWaiting
            #expect(stillDownloadingAfterPersist)
        }

        await fetchGate.open()
        try await createTask.value
        try await startTask.value

        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-created") != nil)
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-new") != nil)
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-old") == nil)
        let createdTx = await storage.getOutbox().first { $0.modelId == "task-created" }
        #expect(createdTx != nil)
        let withheld = (await storage.getMeta()).privacyWithheldTransactionIds
        if let createdTx {
            #expect(!withheld.contains(createdTx.clientTxId))
        }
        #expect((await storage.getMeta()).schemaHash == "new-hash")

        await engine.stop()
    }

    @Test func bootstrapApplyStillSerializesCreatesOnTheMutationQueue() async throws {
        let storage = MockStorageAdapter()
        try await seed(storage, schemaHash: "old-hash")
        let applyGate = ParityGate()
        storage.beforeReplaceSnapshot = { _, _ in
            await applyGate.wait()
        }
        let transport = bootstrappingTransport()
        transport.mutateHandler = { _ in throw URLError(.notConnectedToInternet) }
        let (engine, modelStore) = makeEngine(
            storage: storage,
            transport: transport,
            schemaHash: "new-hash"
        )

        let startTask = Task { @MainActor in
            try await engine.start(groups: ["ws-1"])
        }
        let applyStarted = await waitUntil { await applyGate.isWaiting }
        #expect(applyStarted)

        let createTask = Task { @MainActor in
            try await engine.createOptimisticAndQueue(
                modelName: TestRecord.modelName,
                data: ["id": "task-created", "title": "draft", "category": "inbox"]
            )
        }
        try await Task.sleep(for: .milliseconds(50))
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-created") == nil)

        await applyGate.open()
        try await createTask.value
        try await startTask.value

        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-created") != nil)
        #expect(modelStore.snapshot(modelName: TestRecord.modelName, id: "task-new") != nil)

        await engine.stop()
    }
}

// MARK: - P1-3b: schema-hash granularity

/// The knobs a probe model varies. `probeLoadStrategy` / `probeIndexes` stand in
/// for the fetch-policy metadata the TypeScript `computeSchemaHash` covers and
/// this one deliberately does not.
private protocol SchemaProbeSpec {
    static var probeName: String { get }
    static var probeFields: [SyncSchemaField] { get }
    static var probeLoadStrategy: String { get }
    static var probeIndexes: [[String]] { get }
}

extension SchemaProbeSpec {
    static var probeLoadStrategy: String { "eager" }
    static var probeIndexes: [[String]] { [] }
}

private struct SchemaProbe<Spec: SchemaProbeSpec>: SyncModel, SchemaDescribedModel {
    static var modelName: String { Spec.probeName }
    static var syncSchemaFields: [SyncSchemaField] { Spec.probeFields }

    let id: String

    init(from dictionary: [String: Any]) throws {
        guard let id = dictionary["id"] as? String else {
            throw TestSupportError.missingField("id")
        }
        self.id = id
    }

    func toDictionary() -> [String: Any] { ["id": id] }
    func applying(changes: [String: Any]) -> Self { self }
}

private enum BaseSpec: SchemaProbeSpec {
    static let probeName = "Widget"
    static let probeFields: [SyncSchemaField] = [
        SyncSchemaField(name: "id", codec: "id"),
        SyncSchemaField(name: "title", codec: "string"),
        SyncSchemaField(name: "dueAt", codec: "date"),
    ]
}

/// One field added; everything else identical.
private enum AddedFieldSpec: SchemaProbeSpec {
    static let probeName = BaseSpec.probeName
    static let probeFields: [SyncSchemaField] = BaseSpec.probeFields + [
        SyncSchemaField(name: "note", codec: "optionalString"),
    ]
}

/// `title` flipped from required to nullable; same name, same field count.
private enum NullabilityFlipSpec: SchemaProbeSpec {
    static let probeName = BaseSpec.probeName
    static let probeFields: [SyncSchemaField] = [
        SyncSchemaField(name: "id", codec: "id"),
        SyncSchemaField(name: "title", codec: "optionalString"),
        SyncSchemaField(name: "dueAt", codec: "date"),
    ]
}

/// `dueAt` re-typed from date to double; same name, same nullability.
private enum CodecChangeSpec: SchemaProbeSpec {
    static let probeName = BaseSpec.probeName
    static let probeFields: [SyncSchemaField] = [
        SyncSchemaField(name: "id", codec: "id"),
        SyncSchemaField(name: "title", codec: "string"),
        SyncSchemaField(name: "dueAt", codec: "double"),
    ]
}

/// Identical decoding surface, different fetch policy.
private enum FetchPolicySpec: SchemaProbeSpec {
    static let probeName = BaseSpec.probeName
    static let probeFields: [SyncSchemaField] = BaseSpec.probeFields
    static let probeLoadStrategy = "lazy"
    static let probeIndexes = [["title"], ["dueAt"]]
}

/// A record family that decodes the same field names differently — ISO strings
/// rather than epoch milliseconds, nil keys omitted rather than `NSNull`.
/// This is the `TaskRecord` shape: it must not collide with `BaseSpec`.
private enum ForeignCodecFamilySpec: SchemaProbeSpec {
    static let probeName = BaseSpec.probeName
    static let probeFields: [SyncSchemaField] = [
        SyncSchemaField(name: "id", codec: "id"),
        SyncSchemaField(name: "title", codec: "requiredString"),
        SyncSchemaField(name: "dueAt", codec: "omitNilIsoDate"),
    ]
}

/// A model registered without a ``SchemaDescribedModel`` conformance.
private struct UndescribedRecord: SyncModel {
    static let modelName = "Widget"

    let id: String

    init(from dictionary: [String: Any]) throws {
        guard let id = dictionary["id"] as? String else {
            throw TestSupportError.missingField("id")
        }
        self.id = id
    }

    func toDictionary() -> [String: Any] { ["id": id] }
    func applying(changes: [String: Any]) -> Self { self }
}

@MainActor
@Suite struct SchemaHashGranularityTests {
    private func hashOf<Spec: SchemaProbeSpec>(_ spec: Spec.Type) -> String {
        let store = SyncModelStore()
        store.register(SchemaProbe<Spec>.self)
        return store.registrationsHash
    }

    @Test func hashIsSixteenHexCharactersLikeTheTypeScriptEngine() {
        let value = hashOf(BaseSpec.self)
        #expect(value.count == 16)
        #expect(value.allSatisfy { $0.isHexDigit && !$0.isUppercase })
    }

    @Test func addingAFieldMovesTheHash() {
        #expect(hashOf(BaseSpec.self) != hashOf(AddedFieldSpec.self))
    }

    @Test func flippingNullabilityMovesTheHash() {
        // Same model, same field names, same count: only `title` went nullable.
        #expect(BaseSpec.probeFields.count == NullabilityFlipSpec.probeFields.count)
        #expect(hashOf(BaseSpec.self) != hashOf(NullabilityFlipSpec.self))
    }

    @Test func changingAFieldCodecMovesTheHash() {
        #expect(hashOf(BaseSpec.self) != hashOf(CodecChangeSpec.self))
    }

    @Test func changingFetchPolicyLeavesTheHashAlone() {
        // Guard against a vacuous pass: the specs really do differ.
        #expect(BaseSpec.probeLoadStrategy != FetchPolicySpec.probeLoadStrategy)
        #expect(BaseSpec.probeIndexes != FetchPolicySpec.probeIndexes)
        // ...but neither can change how a persisted row decodes, so no
        // re-bootstrap. This is where the TypeScript hash over-invalidates.
        #expect(hashOf(BaseSpec.self) == hashOf(FetchPolicySpec.self))
    }

    @Test func aDifferentCodecFamilyUnderTheSameFieldNamesMovesTheHash() {
        // The `TaskRecord` case: identical model and field names, genuinely
        // different codecs. Conflating the two would decode stale rows.
        #expect(BaseSpec.probeFields.map(\.name) == ForeignCodecFamilySpec.probeFields.map(\.name))
        #expect(hashOf(BaseSpec.self) != hashOf(ForeignCodecFamilySpec.self))
    }

    @Test func addingAModelStillMovesTheHash() {
        let one = SyncModelStore()
        one.register(SchemaProbe<BaseSpec>.self)
        let two = SyncModelStore()
        two.register(SchemaProbe<BaseSpec>.self)
        two.register(TestRecord.self)
        #expect(one.registrationsHash != two.registrationsHash)
    }

    @Test func fieldOrderAndRegistrationOrderDoNotMatter() {
        let forward = SyncModelStore()
        forward.register(SchemaProbe<BaseSpec>.self)
        forward.register(TestRecord.self)
        let reverse = SyncModelStore()
        reverse.register(TestRecord.self)
        reverse.register(SchemaProbe<BaseSpec>.self)
        #expect(forward.registrationsHash == reverse.registrationsHash)
    }

    @Test func anUndescribedModelHashesOnItsNameAlone() {
        // Documents the hole: without `SchemaDescribedModel` a field change
        // inside the model is invisible, exactly as names-only used to be.
        let described = SyncModelStore()
        described.register(SchemaProbe<BaseSpec>.self)
        let undescribed = SyncModelStore()
        undescribed.register(UndescribedRecord.self)
        #expect(described.registrationsHash != undescribed.registrationsHash)
    }
}

// MARK: - P2-4: per-action echo suppression

@MainActor
@Suite struct EchoSuppressionParityTests {
    @Test func foreignActionSharingARecordWithAnOwnEchoStillApplies() async throws {
        let storage = MockStorageAdapter()
        try await storage.setMeta(parityMeta(cursor: "1", clientId: "client-a"))
        try await storage.put(
            modelName: TestRecord.modelName,
            id: "task-1",
            data: ["id": "task-1", "title": "optimistic", "category": "cat0"]
        )
        // Our own pending update sits in the outbox; the delta will echo it.
        let ownTx = createUpdateTransaction(
            clientId: "client-a",
            modelName: TestRecord.modelName,
            modelId: "task-1",
            changes: ["title": "optimistic"],
            original: ["title": "before"]
        )
        try await storage.addToOutbox(ownTx)

        let transport = MockSyncTransport()
        transport.fetchDeltasHandler = { after, _ in
            guard after == "1" else {
                return DeltaPacket(lastSyncId: after, actions: [], hasMore: false)
            }
            return DeltaPacket(
                lastSyncId: "3",
                actions: [
                    // Our own echo (same tx id + client id).
                    parityAction(
                        syncId: "2",
                        data: ["title": "optimistic"],
                        clientTxId: ownTx.clientTxId,
                        clientId: "client-a"
                    ),
                    // A foreign update to a different field of the same record.
                    parityAction(syncId: "3", data: ["category": "server-cat"]),
                ],
                hasMore: false
            )
        }

        let (orchestrator, modelStore) = makeParityOrchestrator(storage: storage, transport: transport)
        try await orchestrator.start(groups: ["ws-1"])

        // The foreign field lands in the identity map; the own echo is suppressed
        // (the optimistic title is preserved, not re-flashed).
        let snapshot = modelStore.snapshot(modelName: TestRecord.modelName, id: "task-1")
        #expect(snapshot?["category"] as? String == "server-cat")
        #expect(snapshot?["title"] as? String == "optimistic")

        await orchestrator.stop()
    }
}

// MARK: - P3-5: sync-less mutate completion

@MainActor
@Suite struct SyncLessCompletionTests {
    @Test func successWithoutSyncIdCompletesImmediately() async throws {
        let storage = MockStorageAdapter()
        let transport = MockSyncTransport()
        transport.mutateHandler = { batch in
            MutateResult(
                success: true,
                lastSyncId: zeroSyncId,
                results: batch.transactions.map {
                    TransactionResult(clientTxId: $0.clientTxId, success: true, syncId: nil, error: nil)
                }
            )
        }
        let outbox = OutboxManager(
            storage: storage,
            transport: transport,
            clientId: "client-a",
            batchDelay: 0.005
        )

        _ = try await outbox.insert(modelName: TestRecord.modelName, modelId: "t1", data: ["id": "t1"])

        // No syncId and no positive batch cursor: the transaction is durably done
        // and removed, with no requeue loop.
        #expect(await waitUntil { await storage.getOutbox().isEmpty })
        #expect(transport.mutateBatches.count == 1)
    }

    @Test func successWithoutSyncIdFallsBackToBatchCursor() async throws {
        let storage = MockStorageAdapter()
        let transport = MockSyncTransport()
        transport.mutateHandler = { batch in
            MutateResult(
                success: true,
                lastSyncId: "7",
                results: batch.transactions.map {
                    TransactionResult(clientTxId: $0.clientTxId, success: true, syncId: nil, error: nil)
                }
            )
        }
        let outbox = OutboxManager(
            storage: storage,
            transport: transport,
            clientId: "client-a",
            batchDelay: 0.005
        )

        _ = try await outbox.insert(modelName: TestRecord.modelName, modelId: "t1", data: ["id": "t1"])

        #expect(await waitUntil {
            await storage.getOutbox().first?.state == .awaitingSync
        })
        let stored = await storage.getOutbox()
        #expect(stored.first?.syncIdNeededForCompletion == "7")
    }
}
