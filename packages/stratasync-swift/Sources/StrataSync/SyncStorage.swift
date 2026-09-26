import CryptoKit
import Foundation
import SQLite3

/// SQLite's `SQLITE_TRANSIENT` macro doesn't import into Swift. Passing it as
/// the bind destructor makes SQLite copy the buffer during the bind call
/// instead of retaining our pointer, which is required here: the bound Swift
/// strings are temporaries that don't outlive the statement. (Binding with
/// `nil` = `SQLITE_STATIC` left dangling pointers that SQLite read at
/// `sqlite3_step` time, corrupting the connection heap.)
private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

// MARK: - Storage Adapter Protocol

public protocol StorageAdapter {
    func open() async throws
    func close() async throws
    func get(modelName: String, id: String) async -> [String: Any]?
    func getAll(modelName: String) async -> [[String: Any]]
    func put(modelName: String, id: String, data: [String: Any]) async throws
    func delete(modelName: String, id: String) async throws
    func writeBatch(_ ops: [BatchOperation]) async throws
    func getMeta() async -> StorageMeta
    func setMeta(_ meta: StorageMeta) async throws
    func getOutbox() async -> [Transaction]
    func addToOutbox(_ tx: Transaction) async throws
    func removeFromOutbox(clientTxId: String) async throws
    func updateOutboxTransaction(clientTxId: String, updates: (inout Transaction) -> Void) async throws
    func replaceSnapshot(records: [StoredModelRecord], meta: StorageMeta) async throws
    func clear(preserveOutbox: Bool) async throws
}

/// A storage adapter whose durable state is partitioned by authenticated account.
/// Selecting `nil` closes and deselects storage for sign-out without deleting any
/// account's persisted models or outbox.
public protocol AccountScopedStorageAdapter: StorageAdapter {
    func selectAccount(_ accountId: String?) async throws
}

/// A conservative rule used to establish ownership of a legacy unscoped database.
/// A rule is conclusive only when every matching record names one distinct account,
/// and that account is the account currently being selected.
public struct LegacyDatabaseOwnershipRule: Sendable {
    public let modelName: String
    public let accountIdField: String

    public init(modelName: String, accountIdField: String) {
        self.modelName = modelName
        self.accountIdField = accountIdField
    }
}

// MARK: - SQLite Storage

/// Persistent storage backed by SQLite.
///
/// Schema:
/// - `models` table: (model_name TEXT, id TEXT, data TEXT, PRIMARY KEY (model_name, id))
/// - `outbox` table: (client_tx_id TEXT PRIMARY KEY, data TEXT)
/// - `meta` table: (key TEXT PRIMARY KEY, value TEXT)
///
/// This is an `actor`: a SQLite connection is not safe to touch from more than
/// one thread at a time, and the sync engine drives reads/writes from many
/// concurrent tasks (outbox flush, delta apply, bootstrap, UI reads). Actor
/// isolation serialises every access to `db` so the connection is only ever
/// used from one task at a time. The connection is additionally opened in
/// SQLite's serialized threading mode (`SQLITE_OPEN_FULLMUTEX`) as defence in
/// depth.
public actor SQLiteStorage: AccountScopedStorageAdapter {
    private var db: OpaquePointer?
    private let baseDirectory: URL
    private let accountScopedDBName: String?
    private let legacyOwnershipRules: [LegacyDatabaseOwnershipRule]
    private var dbPath: String?
    private var selectedAccountHash: String?

    public init(dbName: String = "sync", directory: URL? = nil) {
        let documentsDirectory = directory
            ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        baseDirectory = documentsDirectory
        accountScopedDBName = nil
        legacyOwnershipRules = []
        dbPath = documentsDirectory.appendingPathComponent("\(dbName).sqlite3").path
    }

    public init(
        accountScopedDBName: String,
        legacyOwnershipRules: [LegacyDatabaseOwnershipRule],
        directory: URL? = nil
    ) {
        let documentsDirectory = directory
            ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        baseDirectory = documentsDirectory
        self.accountScopedDBName = accountScopedDBName
        self.legacyOwnershipRules = legacyOwnershipRules
        dbPath = nil
    }

    public nonisolated static func accountDatabaseName(
        for accountId: String,
        baseName: String = "sync"
    ) -> String {
        "\(baseName)-account-\(accountHash(accountId)).sqlite3"
    }

    public func selectAccount(_ accountId: String?) async throws {
        guard accountScopedDBName != nil else {
            if accountId == nil {
                try await close()
                return
            }
            throw SQLiteError.accountScopingUnavailable
        }

        try await close()
        guard let accountId else {
            dbPath = nil
            selectedAccountHash = nil
            return
        }

        let accountHash = Self.accountHash(accountId)
        let baseName = accountScopedDBName ?? "sync"
        let destination = baseDirectory.appendingPathComponent(
            Self.accountDatabaseName(for: accountId, baseName: baseName)
        )
        try migrateLegacyDatabaseIfEligible(
            to: destination,
            accountId: accountId,
            accountHash: accountHash,
            baseName: baseName
        )
        dbPath = destination.path
        selectedAccountHash = accountHash
    }

    public func open() async throws {
        if db != nil { return }
        guard let dbPath else { throw SQLiteError.accountNotSelected }

        // Serialized threading mode: SQLite guards the connection with its own
        // mutex so a stray cross-thread call can't corrupt it. Actor isolation
        // is the primary guarantee; this is belt-and-braces.
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(dbPath, &db, flags, nil) == SQLITE_OK else {
            let error = db.flatMap { String(cString: sqlite3_errmsg($0)) } ?? "Unknown error"
            throw SQLiteError.openFailed(error)
        }

        // Retry busy waits instead of failing outright if another connection
        // (e.g. a future extension process) ever holds the file lock.
        sqlite3_busy_timeout(db, 5000)

        // Enable WAL mode for better concurrent read/write performance
        try execute("PRAGMA journal_mode=WAL")

        // Create tables
        try execute("""
            CREATE TABLE IF NOT EXISTS models (
                model_name TEXT NOT NULL,
                id TEXT NOT NULL,
                data TEXT NOT NULL,
                PRIMARY KEY (model_name, id)
            )
        """)

        try execute("""
            CREATE TABLE IF NOT EXISTS outbox (
                client_tx_id TEXT PRIMARY KEY,
                data TEXT NOT NULL
            )
        """)

        try execute("""
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)

        if let selectedAccountHash {
            let storedAccountHash = getMetaValue("accountIdHash")
            guard storedAccountHash == nil || storedAccountHash == selectedAccountHash else {
                try await close()
                throw SQLiteError.accountMismatch
            }
            if storedAccountHash == nil {
                try setMetaValue("accountIdHash", value: selectedAccountHash)
            }
        }
    }

    public func close() async throws {
        if let db {
            // close_v2 defers teardown until any straggler statement is
            // finalized instead of leaving a half-closed handle on SQLITE_BUSY.
            sqlite3_close_v2(db)
            self.db = nil
        }
    }

    // MARK: - Model Operations

    public func get(modelName: String, id: String) async -> [String: Any]? {
        guard let db else { return nil }

        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }

        guard sqlite3_prepare_v2(db, "SELECT data FROM models WHERE model_name = ? AND id = ?", -1, &stmt, nil) == SQLITE_OK else {
            return nil
        }

        sqlite3_bind_text(stmt, 1, modelName, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, id, -1, SQLITE_TRANSIENT)

        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }

        guard let dataPtr = sqlite3_column_text(stmt, 0) else { return nil }
        let jsonString = String(cString: dataPtr)
        return deserializeJSON(jsonString)
    }

    public func getAll(modelName: String) async -> [[String: Any]] {
        guard let db else { return [] }

        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }

        guard sqlite3_prepare_v2(db, "SELECT data FROM models WHERE model_name = ?", -1, &stmt, nil) == SQLITE_OK else {
            return []
        }

        sqlite3_bind_text(stmt, 1, modelName, -1, SQLITE_TRANSIENT)

        var results: [[String: Any]] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            guard let dataPtr = sqlite3_column_text(stmt, 0) else { continue }
            let jsonString = String(cString: dataPtr)
            if let dict = deserializeJSON(jsonString) {
                results.append(dict)
            }
        }
        return results
    }

    public func put(modelName: String, id: String, data: [String: Any]) async throws {
        guard let jsonString = serializeJSON(data) else {
            throw SQLiteError.serializationFailed
        }

        try execute(
            "INSERT OR REPLACE INTO models (model_name, id, data) VALUES (?, ?, ?)",
            params: [modelName, id, jsonString]
        )
    }

    public func delete(modelName: String, id: String) async throws {
        try execute(
            "DELETE FROM models WHERE model_name = ? AND id = ?",
            params: [modelName, id]
        )
    }

    public func writeBatch(_ ops: [BatchOperation]) async throws {
        guard db != nil else { throw SQLiteError.notOpen }

        // Run the whole batch synchronously (no `await`) so no other actor
        // message can interleave between BEGIN and COMMIT via reentrancy.
        try execute("BEGIN TRANSACTION")
        do {
            for op in ops {
                switch op {
                case .put(let modelName, let id, let data):
                    guard let jsonString = serializeJSON(data) else {
                        throw SQLiteError.serializationFailed
                    }
                    try execute(
                        "INSERT OR REPLACE INTO models (model_name, id, data) VALUES (?, ?, ?)",
                        params: [modelName, id, jsonString]
                    )
                case .delete(let modelName, let id):
                    try execute(
                        "DELETE FROM models WHERE model_name = ? AND id = ?",
                        params: [modelName, id]
                    )
                }
            }
            try execute("COMMIT")
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    // MARK: - Meta Operations

    public func getMeta() async -> StorageMeta {
        let lastSyncId = getMetaValue("lastSyncId") ?? zeroSyncId
        let storedClientId = getMetaValue("clientId")
        let clientId = storedClientId ?? UUID().uuidString
        let firstSyncId = getMetaValue("firstSyncId")
        let groupsJson = getMetaValue("subscribedGroups") ?? "[]"
        let groups = (try? JSONSerialization.jsonObject(
            with: Data(groupsJson.utf8)
        ) as? [String]) ?? []
        let bootstrapComplete = parseBool(getMetaValue("bootstrapComplete"))
            ?? (lastSyncId != zeroSyncId)
        let groupChangePending = parseBool(getMetaValue("groupChangePending")) ?? false
        let withheldJson = getMetaValue("privacyWithheldTransactionIds") ?? "[]"
        let privacyWithheldTransactionIds = (try? JSONSerialization.jsonObject(
            with: Data(withheldJson.utf8)
        ) as? [String]) ?? []
        let schemaHash = getMetaValue("schemaHash")
        let databaseVersion = getMetaValue("databaseVersion").flatMap(Int.init)
        let lastSyncAt = getMetaValue("lastSyncAt").flatMap(Double.init)
        let authoritativeGroups = getMetaValue("authoritativeGroups").flatMap {
            (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String]
        }

        // Persist clientId if it was just generated
        if storedClientId == nil {
            try? setMetaValue("clientId", value: clientId)
        }

        return StorageMeta(
            lastSyncId: lastSyncId,
            firstSyncId: firstSyncId,
            subscribedGroups: groups,
            clientId: clientId,
            bootstrapComplete: bootstrapComplete,
            groupChangePending: groupChangePending,
            privacyWithheldTransactionIds: privacyWithheldTransactionIds,
            schemaHash: schemaHash,
            databaseVersion: databaseVersion,
            lastSyncAt: lastSyncAt,
            authoritativeGroups: authoritativeGroups
        )
    }

    public func setMeta(_ meta: StorageMeta) async throws {
        try setMetaValues(meta)
    }

    private func setMetaValues(_ meta: StorageMeta) throws {
        try setMetaValue("lastSyncId", value: meta.lastSyncId)
        try setMetaValue("clientId", value: meta.clientId)
        if let firstSyncId = meta.firstSyncId {
            try setMetaValue("firstSyncId", value: firstSyncId)
        } else {
            try deleteMetaValue("firstSyncId")
        }
        if let groupsData = try? JSONSerialization.data(withJSONObject: meta.subscribedGroups),
           let groupsString = String(data: groupsData, encoding: .utf8) {
            try setMetaValue("subscribedGroups", value: groupsString)
        }
        try setMetaValue("bootstrapComplete", value: meta.bootstrapComplete ? "1" : "0")
        try setMetaValue("groupChangePending", value: meta.groupChangePending ? "1" : "0")
        if let withheldData = try? JSONSerialization.data(withJSONObject: meta.privacyWithheldTransactionIds),
           let withheldString = String(data: withheldData, encoding: .utf8) {
            try setMetaValue("privacyWithheldTransactionIds", value: withheldString)
        }
        if let schemaHash = meta.schemaHash {
            try setMetaValue("schemaHash", value: schemaHash)
        } else {
            try deleteMetaValue("schemaHash")
        }
        if let databaseVersion = meta.databaseVersion {
            try setMetaValue("databaseVersion", value: String(databaseVersion))
        } else {
            try deleteMetaValue("databaseVersion")
        }
        if let lastSyncAt = meta.lastSyncAt {
            try setMetaValue("lastSyncAt", value: String(lastSyncAt))
        } else {
            try deleteMetaValue("lastSyncAt")
        }
        if let authoritativeGroups = meta.authoritativeGroups,
           let groupsData = try? JSONSerialization.data(withJSONObject: authoritativeGroups),
           let groupsString = String(data: groupsData, encoding: .utf8) {
            try setMetaValue("authoritativeGroups", value: groupsString)
        } else {
            try deleteMetaValue("authoritativeGroups")
        }
    }

    // MARK: - Outbox Operations

    public func getOutbox() async -> [Transaction] {
        guard let db else { return [] }

        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }

        // SQLite rowid is the durable insertion ordinal for this table. Unlike
        // createdAt + random clientTxId, it preserves dependent mutation order
        // when multiple transactions share the same clock tick.
        guard sqlite3_prepare_v2(
            db,
            "SELECT data FROM outbox ORDER BY rowid ASC",
            -1,
            &stmt,
            nil
        ) == SQLITE_OK else {
            return []
        }

        var results: [Transaction] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            guard let dataPtr = sqlite3_column_text(stmt, 0) else { continue }
            let jsonString = String(cString: dataPtr)
            if let tx = deserializeTransaction(jsonString) {
                results.append(tx)
            }
        }
        return results
    }

    public func addToOutbox(_ tx: Transaction) async throws {
        guard let jsonString = serializeTransaction(tx) else {
            throw SQLiteError.serializationFailed
        }

        try execute(
            "INSERT OR REPLACE INTO outbox (client_tx_id, data) VALUES (?, ?)",
            params: [tx.clientTxId, jsonString]
        )
    }

    public func removeFromOutbox(clientTxId: String) async throws {
        try execute(
            "DELETE FROM outbox WHERE client_tx_id = ?",
            params: [clientTxId]
        )
    }

    public func updateOutboxTransaction(clientTxId: String, updates: (inout Transaction) -> Void) async throws {
        // Read the row synchronously: an `await getOutbox()` here would open an
        // actor-reentrancy window between the read and the UPDATE, allowing a
        // concurrent update to the same transaction to be lost.
        guard var transaction = readOutboxTransaction(clientTxId: clientTxId) else { return }

        updates(&transaction)

        guard let jsonString = serializeTransaction(transaction) else {
            throw SQLiteError.serializationFailed
        }

        try execute(
            "UPDATE outbox SET data = ? WHERE client_tx_id = ?",
            params: [jsonString, clientTxId]
        )
    }

    public func replaceSnapshot(records: [StoredModelRecord], meta: StorageMeta) async throws {
        guard db != nil else { throw SQLiteError.notOpen }

        let serializedRecords = try records.map { record -> (StoredModelRecord, String) in
            guard let jsonString = serializeJSON(record.data) else {
                throw SQLiteError.serializationFailed
            }
            return (record, jsonString)
        }

        try execute("BEGIN TRANSACTION")
        do {
            try execute("DELETE FROM models")
            try execute("DELETE FROM meta")
            for (record, jsonString) in serializedRecords {
                try execute(
                    "INSERT INTO models (model_name, id, data) VALUES (?, ?, ?)",
                    params: [record.modelName, record.id, jsonString]
                )
            }
            try setMetaValues(meta)
            try execute("COMMIT")
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    private func readOutboxTransaction(clientTxId: String) -> Transaction? {
        guard let db else { return nil }

        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }

        guard sqlite3_prepare_v2(db, "SELECT data FROM outbox WHERE client_tx_id = ?", -1, &stmt, nil) == SQLITE_OK else {
            return nil
        }

        sqlite3_bind_text(stmt, 1, clientTxId, -1, SQLITE_TRANSIENT)

        guard sqlite3_step(stmt) == SQLITE_ROW,
              let dataPtr = sqlite3_column_text(stmt, 0) else {
            return nil
        }

        return deserializeTransaction(String(cString: dataPtr))
    }

    // MARK: - Clear

    public func clear(preserveOutbox: Bool) async throws {
        let preservedClientId = getMetaValue("clientId") ?? UUID().uuidString
        let preservedGroupChangePending = getMetaValue("groupChangePending") ?? "0"
        let preservedWithheldTransactionIds =
            getMetaValue("privacyWithheldTransactionIds") ?? "[]"

        try execute("BEGIN TRANSACTION")
        do {
            try execute("DELETE FROM models")
            try execute("DELETE FROM meta")
            if !preserveOutbox {
                try execute("DELETE FROM outbox")
            }

            // Keep the stable client identity across clears. When pending
            // mutations survive, their privacy quarantine must survive in the
            // same transaction so a restart cannot replay withheld rows.
            try setMetaValue("clientId", value: preservedClientId)
            if preserveOutbox {
                try setMetaValue("groupChangePending", value: preservedGroupChangePending)
                try setMetaValue(
                    "privacyWithheldTransactionIds",
                    value: preservedWithheldTransactionIds
                )
            }
            try execute("COMMIT")
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    // MARK: - Account Scoping and Legacy Migration

    private nonisolated static func accountHash(_ accountId: String) -> String {
        SHA256.hash(data: Data(accountId.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    private func migrateLegacyDatabaseIfEligible(
        to destination: URL,
        accountId: String,
        accountHash: String,
        baseName: String
    ) throws {
        let fileManager = FileManager.default
        guard !fileManager.fileExists(atPath: destination.path) else { return }

        let legacyDatabase = baseDirectory.appendingPathComponent("\(baseName).sqlite3")
        guard fileManager.fileExists(atPath: legacyDatabase.path) else { return }

        let ownershipMarker = baseDirectory.appendingPathComponent(
            "\(baseName).legacy-migration-owner"
        )
        if let claimedHash = try? String(contentsOf: ownershipMarker, encoding: .utf8),
           claimedHash != accountHash {
            return
        }

        guard legacyDatabaseBelongsUnambiguously(
            at: legacyDatabase,
            accountId: accountId
        ) else {
            return
        }

        // Claim the legacy database before copying. If the process is killed
        // mid-migration, only this same account can retry; another account can
        // never inherit a partially migrated or ambiguous snapshot.
        try fileManager.createDirectory(
            at: baseDirectory,
            withIntermediateDirectories: true
        )
        try Data(accountHash.utf8).write(to: ownershipMarker, options: .atomic)

        let temporaryDatabase = baseDirectory.appendingPathComponent(
            ".\(baseName)-migration-\(UUID().uuidString).sqlite3"
        )
        let suffixes = ["", "-wal", "-shm"]
        defer {
            for suffix in suffixes {
                try? fileManager.removeItem(
                    at: URL(fileURLWithPath: temporaryDatabase.path + suffix)
                )
            }
        }

        // Copy the complete SQLite file set. The source is deliberately never
        // moved or deleted, so migration failure cannot destroy the only copy.
        for suffix in suffixes {
            let source = URL(fileURLWithPath: legacyDatabase.path + suffix)
            guard fileManager.fileExists(atPath: source.path) else { continue }
            let temporary = URL(fileURLWithPath: temporaryDatabase.path + suffix)
            try fileManager.copyItem(at: source, to: temporary)
        }

        // Fold committed WAL pages into the copied main database before its
        // atomic promotion. This preserves writes that are not yet checkpointed
        // while avoiding a destination whose correctness depends on sidecars.
        try checkpointCopiedDatabase(at: temporaryDatabase)
        try fileManager.moveItem(at: temporaryDatabase, to: destination)
    }

    private func legacyDatabaseBelongsUnambiguously(
        at databaseURL: URL,
        accountId: String
    ) -> Bool {
        guard !legacyOwnershipRules.isEmpty else { return false }

        // Even opening a SQLite database read-only can update its shared-memory
        // sidecar. Inspect a private copy so ambiguous legacy files remain
        // byte-for-byte untouched.
        let fileManager = FileManager.default
        let inspectionDatabase = baseDirectory.appendingPathComponent(
            ".legacy-inspection-\(UUID().uuidString).sqlite3"
        )
        let suffixes = ["", "-wal", "-shm"]
        defer {
            for suffix in suffixes {
                try? fileManager.removeItem(
                    at: URL(fileURLWithPath: inspectionDatabase.path + suffix)
                )
            }
        }
        do {
            for suffix in suffixes {
                let source = URL(fileURLWithPath: databaseURL.path + suffix)
                guard fileManager.fileExists(atPath: source.path) else { continue }
                try fileManager.copyItem(
                    at: source,
                    to: URL(fileURLWithPath: inspectionDatabase.path + suffix)
                )
            }
        } catch {
            return false
        }

        var legacyDB: OpaquePointer?
        let flags = SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(inspectionDatabase.path, &legacyDB, flags, nil) == SQLITE_OK,
              let legacyDB else {
            if legacyDB != nil { sqlite3_close_v2(legacyDB) }
            return false
        }
        defer { sqlite3_close_v2(legacyDB) }

        var observedAccountIds = Set<String>()
        for rule in legacyOwnershipRules {
            var statement: OpaquePointer?
            defer { sqlite3_finalize(statement) }
            guard sqlite3_prepare_v2(
                legacyDB,
                "SELECT data FROM models WHERE model_name = ?",
                -1,
                &statement,
                nil
            ) == SQLITE_OK else {
                continue
            }
            sqlite3_bind_text(statement, 1, rule.modelName, -1, SQLITE_TRANSIENT)

            while sqlite3_step(statement) == SQLITE_ROW {
                guard let dataPointer = sqlite3_column_text(statement, 0),
                      let data = String(cString: dataPointer).data(using: .utf8),
                      let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let recordAccountId = record[rule.accountIdField] as? String,
                      !recordAccountId.isEmpty else {
                    return false
                }
                observedAccountIds.insert(recordAccountId)
            }
        }

        guard observedAccountIds == Set([accountId]) else { return false }

        // Legacy outbox rows do not carry a trusted account identifier. Even
        // when the persisted snapshot has one owner, a queued mutation may
        // have been written after an account switch. Refuse automatic
        // migration rather than replay an unproven mutation under this token;
        // the original database remains available for explicit recovery.
        var outboxStatement: OpaquePointer?
        defer { sqlite3_finalize(outboxStatement) }
        guard sqlite3_prepare_v2(
            legacyDB,
            "SELECT 1 FROM outbox LIMIT 1",
            -1,
            &outboxStatement,
            nil
        ) == SQLITE_OK else {
            return false
        }
        return sqlite3_step(outboxStatement) == SQLITE_DONE
    }

    private func checkpointCopiedDatabase(at databaseURL: URL) throws {
        var copiedDB: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(databaseURL.path, &copiedDB, flags, nil) == SQLITE_OK,
              let copiedDB else {
            let message = copiedDB.flatMap { String(cString: sqlite3_errmsg($0)) }
                ?? "Unknown migration copy error"
            if copiedDB != nil { sqlite3_close_v2(copiedDB) }
            throw SQLiteError.openFailed(message)
        }
        defer { sqlite3_close_v2(copiedDB) }

        var errorMessage: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(
            copiedDB,
            "PRAGMA wal_checkpoint(TRUNCATE)",
            nil,
            nil,
            &errorMessage
        ) == SQLITE_OK else {
            let message = errorMessage.map { String(cString: $0) }
                ?? String(cString: sqlite3_errmsg(copiedDB))
            sqlite3_free(errorMessage)
            throw SQLiteError.executeFailed(message)
        }
    }

    // MARK: - Private SQL Helpers

    private func execute(_ sql: String) throws {
        guard let db else { throw SQLiteError.notOpen }
        var errorMsg: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(db, sql, nil, nil, &errorMsg) == SQLITE_OK else {
            let message = errorMsg.map { String(cString: $0) } ?? "Unknown error"
            sqlite3_free(errorMsg)
            throw SQLiteError.executeFailed(message)
        }
    }

    private func execute(_ sql: String, params: [String]) throws {
        guard let db else { throw SQLiteError.notOpen }

        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }

        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            let error = String(cString: sqlite3_errmsg(db))
            throw SQLiteError.executeFailed(error)
        }

        for (index, param) in params.enumerated() {
            sqlite3_bind_text(stmt, Int32(index + 1), param, -1, SQLITE_TRANSIENT)
        }

        guard sqlite3_step(stmt) == SQLITE_DONE else {
            let error = String(cString: sqlite3_errmsg(db))
            throw SQLiteError.executeFailed(error)
        }
    }

    private func getMetaValue(_ key: String) -> String? {
        guard let db else { return nil }

        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }

        guard sqlite3_prepare_v2(db, "SELECT value FROM meta WHERE key = ?", -1, &stmt, nil) == SQLITE_OK else {
            return nil
        }

        sqlite3_bind_text(stmt, 1, key, -1, SQLITE_TRANSIENT)

        guard sqlite3_step(stmt) == SQLITE_ROW,
              let valuePtr = sqlite3_column_text(stmt, 0) else {
            return nil
        }

        return String(cString: valuePtr)
    }

    private func setMetaValue(_ key: String, value: String) throws {
        try execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
            params: [key, value]
        )
    }

    private func deleteMetaValue(_ key: String) throws {
        try execute(
            "DELETE FROM meta WHERE key = ?",
            params: [key]
        )
    }

    private func parseBool(_ value: String?) -> Bool? {
        guard let value else { return nil }

        switch value.lowercased() {
        case "1", "true":
            return true
        case "0", "false":
            return false
        default:
            return nil
        }
    }

    // MARK: - JSON Serialization

    private func serializeJSON(_ dict: [String: Any]) -> String? {
        guard JSONSerialization.isValidJSONObject(dict) else { return nil }
        guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func deserializeJSON(_ jsonString: String) -> [String: Any]? {
        guard let data = jsonString.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    // MARK: - Transaction Serialization

    private func serializeTransaction(_ tx: Transaction) -> String? {
        var dict: [String: Any] = [
            "clientTxId": tx.clientTxId,
            "clientId": tx.clientId,
            "modelName": tx.modelName,
            "modelId": tx.modelId,
            "action": tx.action.rawValue,
            "payload": tx.payload,
            "state": tx.state.rawValue,
            "createdAt": tx.createdAt,
            "retryCount": tx.retryCount,
        ]
        if let original = tx.original {
            dict["original"] = original
        }
        if let lastError = tx.lastError {
            dict["lastError"] = lastError
        }
        if let syncId = tx.syncIdNeededForCompletion {
            dict["syncIdNeededForCompletion"] = syncId
        }
        return serializeJSON(dict)
    }

    private func deserializeTransaction(_ jsonString: String) -> Transaction? {
        guard let dict = deserializeJSON(jsonString),
              let clientTxId = dict["clientTxId"] as? String,
              let clientId = dict["clientId"] as? String,
              let modelName = dict["modelName"] as? String,
              let modelId = dict["modelId"] as? String,
              let actionStr = dict["action"] as? String,
              let action = TransactionAction(rawValue: actionStr),
              let payload = dict["payload"] as? [String: Any],
              let stateStr = dict["state"] as? String,
              let state = TransactionState(rawValue: stateStr),
              let createdAt = dict["createdAt"] as? TimeInterval,
              let retryCount = dict["retryCount"] as? Int else {
            return nil
        }

        return Transaction(
            clientTxId: clientTxId,
            clientId: clientId,
            modelName: modelName,
            modelId: modelId,
            action: action,
            payload: payload,
            original: dict["original"] as? [String: Any],
            state: state,
            createdAt: createdAt,
            retryCount: retryCount,
            lastError: dict["lastError"] as? String,
            syncIdNeededForCompletion: dict["syncIdNeededForCompletion"] as? String
        )
    }
}

// MARK: - Errors

enum SQLiteError: Error, LocalizedError {
    case accountMismatch
    case accountNotSelected
    case accountScopingUnavailable
    case openFailed(String)
    case notOpen
    case executeFailed(String)
    case serializationFailed

    var errorDescription: String? {
        switch self {
        case .accountMismatch: "SQLite database belongs to a different account"
        case .accountNotSelected: "No authenticated account selected for SQLite storage"
        case .accountScopingUnavailable: "SQLite storage was not configured for account scoping"
        case .openFailed(let msg): "SQLite open failed: \(msg)"
        case .notOpen: "SQLite database not open"
        case .executeFailed(let msg): "SQLite execute failed: \(msg)"
        case .serializationFailed: "JSON serialization failed"
        }
    }
}
