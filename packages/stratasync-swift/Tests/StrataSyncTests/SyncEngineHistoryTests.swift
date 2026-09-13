import Testing
@testable import StrataSync

@MainActor
struct SyncEngineHistoryTests {
    @Test func createCanUndoAndRedo() async throws {
        let modelStore = SyncModelStore()
        let records = modelStore.register(TestRecord.self)
        let engine = SyncEngine(
            transport: SyncTransport(
                syncEndpoint: "https://example.test/sync",
                wsEndpoint: "wss://example.test/sync",
                getToken: { "token" }
            ),
            storage: MockStorageAdapter(),
            modelStore: modelStore
        )
        engine.enablePreviewStore()

        try await engine.create(
            modelName: TestRecord.modelName,
            data: [
                "id": "task-1",
                "title": "Created",
                "category": "inbox",
            ]
        )

        #expect(records.get("task-1")?.title == "Created")
        #expect(engine.canUndo)

        await engine.undo()

        #expect(records.get("task-1") == nil)
        #expect(engine.canRedo)

        await engine.redo()

        #expect(records.get("task-1")?.title == "Created")
    }

    @Test func deleteCanUndoAndRedo() async throws {
        let modelStore = SyncModelStore()
        let records = modelStore.register(TestRecord.self)
        let engine = SyncEngine(
            transport: SyncTransport(
                syncEndpoint: "https://example.test/sync",
                wsEndpoint: "wss://example.test/sync",
                getToken: { "token" }
            ),
            storage: MockStorageAdapter(),
            modelStore: modelStore
        )
        engine.enablePreviewStore()
        modelStore.set(
            modelName: TestRecord.modelName,
            data: [
                "id": "task-1",
                "title": "Deleted",
                "category": "inbox",
            ]
        )

        try await engine.delete(modelName: TestRecord.modelName, id: "task-1")

        #expect(records.get("task-1") == nil)
        #expect(engine.canUndo)

        await engine.undo()

        #expect(records.get("task-1")?.title == "Deleted")
        #expect(engine.canRedo)

        await engine.redo()

        #expect(records.get("task-1") == nil)
    }

    @Test func runAsUndoGroupUndoesAndRedoesGroupedUpdatesTogether() async throws {
        let modelStore = SyncModelStore()
        let records = modelStore.register(TestRecord.self)
        let engine = SyncEngine(
            transport: SyncTransport(
                syncEndpoint: "https://example.test/sync",
                wsEndpoint: "wss://example.test/sync",
                getToken: { "token" }
            ),
            storage: MockStorageAdapter(),
            modelStore: modelStore
        )
        engine.enablePreviewStore()

        try await engine.create(
            modelName: TestRecord.modelName,
            data: [
                "id": "task-1",
                "title": "First",
                "category": "inbox",
            ]
        )
        try await engine.create(
            modelName: TestRecord.modelName,
            data: [
                "id": "task-2",
                "title": "Second",
                "category": "inbox",
            ]
        )

        try await engine.runAsUndoGroup {
            try await engine.update(
                modelName: TestRecord.modelName,
                id: "task-1",
                changes: ["category": "today"]
            )
            try await engine.update(
                modelName: TestRecord.modelName,
                id: "task-2",
                changes: ["category": "today"]
            )
        }

        #expect(records.get("task-1")?.category == "today")
        #expect(records.get("task-2")?.category == "today")

        await engine.undo()

        #expect(records.get("task-1")?.category == "inbox")
        #expect(records.get("task-2")?.category == "inbox")

        await engine.redo()

        #expect(records.get("task-1")?.category == "today")
        #expect(records.get("task-2")?.category == "today")
    }
}
