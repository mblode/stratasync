import Testing
@testable import StrataSync

@MainActor
struct SyncModelStoreTests {
    @Test func registersModelsAndTracksSupportedNames() throws {
        let store = SyncModelStore()
        _ = store.register(TestRecord.self)

        #expect(store.supportedModelNames == [TestRecord.modelName])
    }

    @Test func setMergeUpdateAndSnapshotUseRegisteredMap() throws {
        let store = SyncModelStore()
        _ = store.register(TestRecord.self)

        store.set(
            modelName: TestRecord.modelName,
            data: [
                "id": "task-1",
                "title": "Original",
                "category": "inbox",
            ]
        )
        store.update(
            modelName: TestRecord.modelName,
            id: "task-1",
            changes: ["title": "Updated"]
        )

        #expect(store.snapshot(modelName: TestRecord.modelName, id: "task-1")?["title"] as? String == "Updated")
    }

    @Test func clearAllRemovesDataFromRegisteredMaps() throws {
        let store = SyncModelStore()
        _ = store.register(TestRecord.self)

        store.set(
            modelName: TestRecord.modelName,
            data: [
                "id": "task-1",
                "title": "Original",
                "category": "inbox",
            ]
        )
        store.clearAll()

        #expect(store.snapshot(modelName: TestRecord.modelName, id: "task-1") == nil)
    }

    @Test func hasPersistedDataDetectsStoredRows() async throws {
        let store = SyncModelStore()
        _ = store.register(TestRecord.self)
        let adapter = MockStorageAdapter()

        try await adapter.put(
            modelName: TestRecord.modelName,
            id: "task-1",
            data: [
                "id": "task-1",
                "title": "Persisted",
                "category": "inbox",
            ]
        )

        #expect(await store.hasPersistedData(storage: adapter) == true)
    }

    @Test func hydrateFromStorageLoadsRegisteredModels() async throws {
        let store = SyncModelStore()
        _ = store.register(TestRecord.self)
        let adapter = MockStorageAdapter()

        try await adapter.put(
            modelName: TestRecord.modelName,
            id: "task-1",
            data: [
                "id": "task-1",
                "title": "Persisted",
                "category": "inbox",
            ]
        )

        try await store.hydrateFromStorage(adapter)
        #expect(store.snapshot(modelName: TestRecord.modelName, id: "task-1")?["title"] as? String == "Persisted")
    }
}
