import Foundation
import Testing
@testable import StrataSync

/// Regression coverage for the TestFlight EXC_BAD_ACCESS crashes inside
/// libsqlite3: builds 1.0(2)–(5) drove one SQLite connection from many
/// concurrent tasks (outbox flush vs delta apply vs UI reads) and corrupted
/// its internal state. `SQLiteStorage` is an actor (plus `FULLMUTEX`) so every
/// access is serialized; this test hammers the storage from many tasks at
/// once and would crash the process if that serialization ever regressed.
@Suite struct SyncStorageConcurrencyTests {
    private func makeStorage() async throws -> (SQLiteStorage, String) {
        let dbName = "concurrency-test-\(UUID().uuidString)"
        let storage = SQLiteStorage(dbName: dbName)
        try await storage.open()
        return (storage, dbName)
    }

    private func removeDatabase(named dbName: String) {
        let documentsDir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        for suffix in ["", "-wal", "-shm"] {
            let url = documentsDir.appendingPathComponent("\(dbName).sqlite3\(suffix)")
            try? FileManager.default.removeItem(at: url)
        }
    }

    private func makeTransaction(index: Int) -> Transaction {
        Transaction(
            clientTxId: "tx-\(index)",
            clientId: "client-test",
            modelName: "Task",
            modelId: "task-\(index)",
            action: .insert,
            payload: ["id": "task-\(index)", "title": "Concurrent task \(index)"],
            original: nil,
            state: .queued,
            createdAt: Date().timeIntervalSince1970,
            retryCount: 0
        )
    }

    @Test func concurrentReadsWritesAndOutboxOpsDoNotCorruptTheConnection() async throws {
        let (storage, dbName) = try await makeStorage()
        defer { removeDatabase(named: dbName) }

        let workers = 50
        let opsPerWorker = 20

        try await withThrowingTaskGroup(of: Void.self) { group in
            for worker in 0..<workers {
                group.addTask {
                    for op in 0..<opsPerWorker {
                        let index = worker * opsPerWorker + op
                        switch index % 6 {
                        case 0:
                            try await storage.put(
                                modelName: "Task",
                                id: "task-\(index)",
                                data: ["id": "task-\(index)", "title": "Task \(index)"]
                            )
                        case 1:
                            _ = await storage.get(modelName: "Task", id: "task-\(max(0, index - 7))")
                        case 2:
                            _ = await storage.getAll(modelName: "Task")
                        case 3:
                            try await storage.addToOutbox(self.makeTransaction(index: index))
                        case 4:
                            // Races against the addToOutbox writers on purpose;
                            // missing rows are fine, corruption is not.
                            try? await storage.updateOutboxTransaction(clientTxId: "tx-\(max(0, index - 3))") {
                                $0.state = .sent
                                $0.retryCount += 1
                            }
                        default:
                            var meta = await storage.getMeta()
                            meta.lastSyncAt = Date().timeIntervalSince1970
                            try await storage.setMeta(meta)
                        }
                    }
                }
            }
            try await group.waitForAll()
        }

        // Sanity: the database is still coherent after the storm.
        let tasks = await storage.getAll(modelName: "Task")
        #expect(!tasks.isEmpty)
        let outbox = await storage.getOutbox()
        #expect(!outbox.isEmpty)
        try await storage.close()
    }

    @Test func replaceSnapshotIsAtomicAndPreservesOutbox() async throws {
        let (storage, dbName) = try await makeStorage()
        defer { removeDatabase(named: dbName) }
        try await storage.put(
            modelName: "Task",
            id: "old",
            data: ["id": "old", "title": "Old"]
        )
        var oldMeta = await storage.getMeta()
        oldMeta.lastSyncId = "7"
        oldMeta.bootstrapComplete = true
        oldMeta.groupChangePending = true
        oldMeta.privacyWithheldTransactionIds = ["tx-private"]
        try await storage.setMeta(oldMeta)
        #expect((await storage.getMeta()).groupChangePending)
        #expect((await storage.getMeta()).privacyWithheldTransactionIds == ["tx-private"])
        let pending = makeTransaction(index: 1)
        try await storage.addToOutbox(pending)

        var replacementMeta = oldMeta
        replacementMeta.lastSyncId = "9"
        replacementMeta.groupChangePending = false
        try await storage.replaceSnapshot(
            records: [
                StoredModelRecord(
                    modelName: "Task",
                    id: "new",
                    data: ["id": "new", "title": "New"]
                ),
            ],
            meta: replacementMeta
        )

        #expect(await storage.get(modelName: "Task", id: "old") == nil)
        #expect(await storage.get(modelName: "Task", id: "new")?["title"] as? String == "New")
        #expect((await storage.getMeta()).lastSyncId == "9")
        #expect(!(await storage.getMeta()).groupChangePending)
        #expect((await storage.getMeta()).privacyWithheldTransactionIds == ["tx-private"])
        #expect(await storage.getOutbox().contains { $0.clientTxId == pending.clientTxId })

        var invalidMeta = replacementMeta
        invalidMeta.lastSyncId = "10"
        await #expect(throws: SQLiteError.self) {
            try await storage.replaceSnapshot(
                records: [
                    StoredModelRecord(
                        modelName: "Task",
                        id: "invalid",
                        data: ["id": "invalid", "unsupported": Date()]
                    ),
                ],
                meta: invalidMeta
            )
        }

        #expect(await storage.get(modelName: "Task", id: "new") != nil)
        #expect(await storage.get(modelName: "Task", id: "invalid") == nil)
        #expect((await storage.getMeta()).lastSyncId == "9")
        #expect(await storage.getOutbox().contains { $0.clientTxId == pending.clientTxId })
        try await storage.close()
    }

    @Test func outboxPreservingClearKeepsPrivacyQuarantineAcrossRestart() async throws {
        let (storage, dbName) = try await makeStorage()
        defer { removeDatabase(named: dbName) }

        try await storage.put(
            modelName: "Task",
            id: "private",
            data: ["id": "private", "title": "Private"]
        )
        let pending = makeTransaction(index: 1)
        try await storage.addToOutbox(pending)
        var meta = await storage.getMeta()
        meta.clientId = "client-stable"
        meta.groupChangePending = true
        meta.privacyWithheldTransactionIds = [pending.clientTxId]
        try await storage.setMeta(meta)

        try await storage.clear(preserveOutbox: true)
        try await storage.close()

        let reopened = SQLiteStorage(dbName: dbName)
        try await reopened.open()
        let reopenedMeta = await reopened.getMeta()
        #expect(reopenedMeta.clientId == "client-stable")
        #expect(reopenedMeta.groupChangePending)
        #expect(reopenedMeta.privacyWithheldTransactionIds == [pending.clientTxId])
        #expect(await reopened.get(modelName: "Task", id: "private") == nil)
        #expect(await reopened.getOutbox().map(\.clientTxId) == [pending.clientTxId])
        try await reopened.close()
    }

    @Test func destructiveClearDropsPrivacyQuarantineAndOutbox() async throws {
        let (storage, dbName) = try await makeStorage()
        defer { removeDatabase(named: dbName) }

        let pending = makeTransaction(index: 1)
        try await storage.addToOutbox(pending)
        var meta = await storage.getMeta()
        meta.clientId = "client-stable"
        meta.groupChangePending = true
        meta.privacyWithheldTransactionIds = [pending.clientTxId]
        try await storage.setMeta(meta)

        try await storage.clear(preserveOutbox: false)
        try await storage.close()

        let reopened = SQLiteStorage(dbName: dbName)
        try await reopened.open()
        let reopenedMeta = await reopened.getMeta()
        #expect(reopenedMeta.clientId == "client-stable")
        #expect(!reopenedMeta.groupChangePending)
        #expect(reopenedMeta.privacyWithheldTransactionIds.isEmpty)
        #expect(await reopened.getOutbox().isEmpty)
        try await reopened.close()
    }
}
