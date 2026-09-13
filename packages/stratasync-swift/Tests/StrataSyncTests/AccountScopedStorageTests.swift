import Foundation
import Testing
@testable import StrataSync

@MainActor
@Suite(.serialized)
struct AccountScopedStorageTests {
    @Test func accountSwitchesIsolateAndRestoreModelsCursorsAndOutboxesOffline() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let storage = SQLiteStorage(
            accountScopedDBName: "sync",
            legacyOwnershipRules: [],
            directory: directory
        )
        let modelStore = SyncModelStore()
        let records = modelStore.register(TestRecord.self)
        let engine = SyncEngine(
            transport: MockSyncTransport(),
            storage: storage,
            modelStore: modelStore
        )

        try await engine.resetForAccount("account-a")
        try await engine.createOptimisticAndQueue(
            modelName: TestRecord.modelName,
            data: testRecord(id: "a-record", title: "Account A")
        )
        var accountAMeta = await storage.getMeta()
        accountAMeta.lastSyncId = "41"
        accountAMeta.bootstrapComplete = true
        try await storage.setMeta(accountAMeta)
        let accountATransactions = await storage.getOutbox()
        #expect(accountATransactions.count == 1)
        #expect(records.get("a-record")?.title == "Account A")

        try await engine.resetForAccount("account-b")
        #expect(engine.boundAccountId == "account-b")
        #expect(engine.lastSyncId == zeroSyncId)
        #expect(records.get("a-record") == nil)
        #expect(await storage.getOutbox().isEmpty)
        try await engine.createOptimisticAndQueue(
            modelName: TestRecord.modelName,
            data: testRecord(id: "b-record", title: "Account B")
        )
        let accountBTransactions = await storage.getOutbox()
        #expect(accountBTransactions.count == 1)
        #expect(accountBTransactions.first?.clientTxId != accountATransactions.first?.clientTxId)

        try await engine.resetForAccount("account-a")
        #expect(engine.boundAccountId == "account-a")
        #expect(engine.lastSyncId == "41")
        #expect(records.get("a-record")?.title == "Account A")
        #expect(records.get("b-record") == nil)
        #expect(await storage.getOutbox().map(\.clientTxId) == accountATransactions.map(\.clientTxId))

        try await engine.resetForAccount(nil)
        #expect(engine.boundAccountId == nil)
        #expect(!engine.isLocalDataReady)
        #expect(engine.pendingCount == 0)
        #expect(engine.lastSyncId == zeroSyncId)
        #expect(records.values.isEmpty)
        #expect(!engine.canUndo)

        try await engine.resetForAccount("account-b")
        #expect(records.get("b-record")?.title == "Account B")
        #expect(records.get("a-record") == nil)
        #expect(await storage.getOutbox().map(\.clientTxId) == accountBTransactions.map(\.clientTxId))
        await engine.stop()
    }

    @Test func unambiguousLegacyDatabaseWithoutOutboxMigratesOnceAndKeepsSourceFiles() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let accountId = "account-a"
        let legacy = SQLiteStorage(dbName: "sync", directory: directory)
        try await legacy.open()
        try await legacy.put(
            modelName: "User",
            id: accountId,
            data: ["id": accountId, "email": "a@example.com"]
        )
        try await legacy.put(
            modelName: TestRecord.modelName,
            id: "legacy-record",
            data: testRecord(id: "legacy-record", title: "Legacy A")
        )
        var legacyMeta = await legacy.getMeta()
        legacyMeta.lastSyncId = "27"
        legacyMeta.bootstrapComplete = true
        try await legacy.setMeta(legacyMeta)
        try await legacy.close()

        let legacyDatabase = directory.appendingPathComponent("sync.sqlite3")
        let legacyWAL = URL(fileURLWithPath: legacyDatabase.path + "-wal")
        let legacySHM = URL(fileURLWithPath: legacyDatabase.path + "-shm")
        try Data().write(to: legacyWAL)
        try Data().write(to: legacySHM)

        let scoped = makeScopedStorage(directory: directory)
        try await scoped.selectAccount(accountId)
        try await scoped.open()

        #expect(await scoped.get(modelName: TestRecord.modelName, id: "legacy-record")?["title"] as? String == "Legacy A")
        #expect((await scoped.getMeta()).lastSyncId == "27")
        #expect(await scoped.getOutbox().isEmpty)
        #expect(FileManager.default.fileExists(atPath: legacyDatabase.path))
        #expect(FileManager.default.fileExists(atPath: legacyWAL.path))
        #expect(FileManager.default.fileExists(atPath: legacySHM.path))

        try await scoped.selectAccount("account-b")
        try await scoped.open()
        #expect(await scoped.get(modelName: TestRecord.modelName, id: "legacy-record") == nil)
        #expect(await scoped.getOutbox().isEmpty)
        try await scoped.close()
    }

    @Test func conflictingOwnershipEvidenceAcrossRulesPreventsLegacyMigration() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let legacy = SQLiteStorage(dbName: "sync", directory: directory)
        try await legacy.open()
        try await legacy.put(
            modelName: "User",
            id: "account-a",
            data: ["id": "account-a"]
        )
        try await legacy.put(
            modelName: "AgentThread",
            id: "thread-b",
            data: ["id": "thread-b", "userId": "account-b"]
        )
        try await legacy.close()

        let scoped = SQLiteStorage(
            accountScopedDBName: "sync",
            legacyOwnershipRules: [
                LegacyDatabaseOwnershipRule(modelName: "User", accountIdField: "id"),
                LegacyDatabaseOwnershipRule(modelName: "AgentThread", accountIdField: "userId"),
            ],
            directory: directory
        )
        try await scoped.selectAccount("account-a")
        try await scoped.open()

        #expect(await scoped.get(modelName: "User", id: "account-a") == nil)
        #expect(await scoped.get(modelName: "AgentThread", id: "thread-b") == nil)
        #expect(FileManager.default.fileExists(atPath: directory.appendingPathComponent("sync.sqlite3").path))
        try await scoped.close()
    }

    @Test func unprovenLegacyOutboxPreventsAutomaticMigration() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let legacy = SQLiteStorage(dbName: "sync", directory: directory)
        try await legacy.open()
        try await legacy.put(
            modelName: "User",
            id: "account-a",
            data: ["id": "account-a"]
        )
        let legacyTransaction = transaction(id: "legacy-tx", modelId: "offline-unknown")
        try await legacy.addToOutbox(legacyTransaction)
        try await legacy.close()

        let scoped = makeScopedStorage(directory: directory)
        try await scoped.selectAccount("account-a")
        try await scoped.open()

        #expect(await scoped.get(modelName: "User", id: "account-a") == nil)
        #expect(await scoped.getOutbox().isEmpty)

        let legacyReader = SQLiteStorage(dbName: "sync", directory: directory)
        try await legacyReader.open()
        #expect(await legacyReader.getOutbox().map(\.clientTxId) == [legacyTransaction.clientTxId])
        try await legacyReader.close()
        try await scoped.close()
    }

    @Test func ambiguousLegacyDatabaseAndSidecarsRemainUntouched() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let legacy = SQLiteStorage(dbName: "sync", directory: directory)
        try await legacy.open()
        for accountId in ["account-a", "account-b"] {
            try await legacy.put(
                modelName: "User",
                id: accountId,
                data: ["id": accountId, "email": "\(accountId)@example.com"]
            )
        }
        try await legacy.put(
            modelName: TestRecord.modelName,
            id: "ambiguous-record",
            data: testRecord(id: "ambiguous-record", title: "Do not assign")
        )
        try await legacy.close()

        let legacyDatabase = directory.appendingPathComponent("sync.sqlite3")
        let legacyWAL = URL(fileURLWithPath: legacyDatabase.path + "-wal")
        let legacySHM = URL(fileURLWithPath: legacyDatabase.path + "-shm")
        let walSentinel = Data("retained-wal".utf8)
        let shmSentinel = Data("retained-shm".utf8)
        try walSentinel.write(to: legacyWAL)
        try shmSentinel.write(to: legacySHM)
        let legacyData = try Data(contentsOf: legacyDatabase)

        let scoped = makeScopedStorage(directory: directory)
        try await scoped.selectAccount("account-a")
        try await scoped.open()

        #expect(await scoped.get(modelName: TestRecord.modelName, id: "ambiguous-record") == nil)
        #expect(try Data(contentsOf: legacyDatabase) == legacyData)
        #expect(try Data(contentsOf: legacyWAL) == walSentinel)
        #expect(try Data(contentsOf: legacySHM) == shmSentinel)
        try await scoped.close()
    }

    @Test func accountDatabaseNamesAreDeterministicAndFilesystemSafe() {
        let first = SQLiteStorage.accountDatabaseName(for: "User/../../A")
        let repeated = SQLiteStorage.accountDatabaseName(for: "User/../../A")
        let second = SQLiteStorage.accountDatabaseName(for: "user-b")

        #expect(first == repeated)
        #expect(first != second)
        let digest = first
            .dropFirst("sync-account-".count)
            .dropLast(".sqlite3".count)
        #expect(first.hasPrefix("sync-account-"))
        #expect(first.hasSuffix(".sqlite3"))
        #expect(digest.count == 64)
        #expect(digest.allSatisfy { $0.isHexDigit && !$0.isUppercase })
    }

    private func makeScopedStorage(directory: URL) -> SQLiteStorage {
        SQLiteStorage(
            accountScopedDBName: "sync",
            legacyOwnershipRules: [
                LegacyDatabaseOwnershipRule(modelName: "User", accountIdField: "id"),
            ],
            directory: directory
        )
    }

    private func makeTemporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("stratasync-account-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        return directory
    }

    private func testRecord(id: String, title: String) -> [String: Any] {
        [
            "id": id,
            "title": title,
            "category": "account-test",
            "sortOrder": NSNull(),
            "archivedAt": NSNull(),
        ]
    }

    private func transaction(id: String, modelId: String) -> Transaction {
        Transaction(
            clientTxId: id,
            clientId: "legacy-client",
            modelName: TestRecord.modelName,
            modelId: modelId,
            action: .insert,
            payload: testRecord(id: modelId, title: "Offline"),
            original: nil,
            state: .queued,
            createdAt: 1,
            retryCount: 0
        )
    }
}
