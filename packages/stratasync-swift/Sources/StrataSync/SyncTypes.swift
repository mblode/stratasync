import Foundation

/// PostgreSQL's UUID type serializes identifiers in lowercase, while
/// `UUID.uuidString` uses uppercase hex. Treat both spellings as one logical
/// identity before they reach the outbox or identity maps.
func canonicalSyncModelId(_ value: String) -> String {
    UUID(uuidString: value) == nil ? value : value.lowercased()
}

func canonicalSyncIdentityFields(_ values: [String: Any]) -> [String: Any] {
    var canonical = values
    for (key, value) in values where key == "id" || key.hasSuffix("Id") {
        guard let stringValue = value as? String else { continue }
        canonical[key] = canonicalSyncModelId(stringValue)
    }
    return canonical
}

// MARK: - SyncId

/// Sync ID: string on the wire, represents a monotonically increasing integer.
public typealias SyncId = String

public let zeroSyncId: SyncId = "0"

/// Sync IDs are unsigned base-10 integers encoded as strings on the wire.
/// Rejecting any other representation prevents malformed cursors from being
/// treated as ordered values by the length-based comparator below.
public func isValidSyncId(_ syncId: SyncId) -> Bool {
    !syncId.isEmpty && syncId.utf8.allSatisfy { byte in
        byte >= 48 && byte <= 57
    }
}

/// Compares two string-encoded sync IDs numerically.
public func compareSyncId(_ a: SyncId, _ b: SyncId) -> Int {
    let aStripped = a.drop(while: { $0 == "0" })
    let bStripped = b.drop(while: { $0 == "0" })
    let aFinal = aStripped.isEmpty ? "0" : String(aStripped)
    let bFinal = bStripped.isEmpty ? "0" : String(bStripped)

    if aFinal.count != bFinal.count {
        return aFinal.count - bFinal.count
    }
    if aFinal < bFinal { return -1 }
    if aFinal > bFinal { return 1 }
    return 0
}

public func maxSyncId(_ a: SyncId, _ b: SyncId) -> SyncId {
    compareSyncId(a, b) >= 0 ? a : b
}

public func isSyncIdGreaterThan(_ a: SyncId, _ b: SyncId) -> Bool {
    compareSyncId(a, b) > 0
}

// MARK: - Enums

public enum TransactionAction: String, Sendable {
    case insert = "I"
    case update = "U"
    case archive = "A"
    case delete = "D"
    case unarchive = "V"

    /// Maps to the wire format action names used by /sync/mutate
    public var wireAction: String {
        switch self {
        case .insert: "INSERT"
        case .update: "UPDATE"
        case .delete: "DELETE"
        case .archive: "ARCHIVE"
        case .unarchive: "UNARCHIVE"
        }
    }
}

public enum SyncActionType: String, Sendable {
    case insert = "I"
    case update = "U"
    case archive = "A"
    case delete = "D"
    case unarchive = "V"
    case coverage = "C"
    case group = "G"
    case syncGroup = "S"
}

public enum TransactionState: String, Sendable {
    case queued
    case sent
    case awaitingSync
    case completed
    case failed
}

public enum SyncClientState: String, Sendable {
    case disconnected
    case connecting
    case bootstrapping
    case syncing
    case error
}

public enum ConnectionState: String, Sendable {
    case disconnected
    case connecting
    case connected
    case reconnecting
    case error
}

public enum SyncStatus: String, Sendable {
    case synced
    case syncing
    case offline
    case error
}

// MARK: - Sync Action

public struct SyncAction: @unchecked Sendable {
    public let id: SyncId
    public let modelName: String
    public let modelId: String
    public let action: SyncActionType
    public let data: [String: Any]
    public let groupId: String?
    public let groups: [String]?
    public let clientTxId: String?
    public let clientId: String?

    public init(
        id: SyncId,
        modelName: String,
        modelId: String,
        action: SyncActionType,
        data: [String: Any],
        groupId: String?,
        groups: [String]?,
        clientTxId: String?,
        clientId: String?
    ) {
        self.id = id
        self.modelName = modelName
        self.modelId = canonicalSyncModelId(modelId)
        self.action = action
        self.data = canonicalSyncIdentityFields(data)
        self.groupId = groupId
        self.groups = groups
        self.clientTxId = clientTxId
        self.clientId = clientId
    }
}

// MARK: - Delta Packet

public struct DeltaPacket: @unchecked Sendable {
    public let lastSyncId: SyncId
    public let actions: [SyncAction]
    public let hasMore: Bool

    public init(lastSyncId: SyncId, actions: [SyncAction], hasMore: Bool) {
        self.lastSyncId = lastSyncId
        self.actions = actions
        self.hasMore = hasMore
    }
}

// MARK: - Bootstrap

public struct BootstrapMetadata: @unchecked Sendable {
    public var lastSyncId: SyncId?
    public var subscribedSyncGroups: [String]
    public var returnedModelsCount: [String: Int]?
    public var schemaHash: String?
    public var databaseVersion: Int?

    public init(
        lastSyncId: SyncId? = nil,
        subscribedSyncGroups: [String],
        returnedModelsCount: [String: Int]? = nil,
        schemaHash: String? = nil,
        databaseVersion: Int? = nil
    ) {
        self.lastSyncId = lastSyncId
        self.subscribedSyncGroups = subscribedSyncGroups
        self.returnedModelsCount = returnedModelsCount
        self.schemaHash = schemaHash
        self.databaseVersion = databaseVersion
    }
}

public enum BootstrapEvent: @unchecked Sendable {
    case model(modelName: String, data: [String: Any])
    case metadata(BootstrapMetadata)
    /// The stream's end marker. Distinct from a skippable line so a truncated
    /// bootstrap can be told apart from a complete one.
    case end(rowCount: Int?)
}

// MARK: - Transaction

public struct Transaction: @unchecked Sendable {
    public let clientTxId: String
    public let clientId: String
    public let modelName: String
    public let modelId: String
    public let action: TransactionAction
    public let payload: [String: Any]
    public var original: [String: Any]?
    public var state: TransactionState
    public let createdAt: TimeInterval
    public var retryCount: Int
    public var lastError: String?
    public var syncIdNeededForCompletion: SyncId?
    public var batchIndex: Int?

    public init(
        clientTxId: String,
        clientId: String,
        modelName: String,
        modelId: String,
        action: TransactionAction,
        payload: [String: Any],
        original: [String: Any]?,
        state: TransactionState,
        createdAt: TimeInterval,
        retryCount: Int,
        lastError: String? = nil,
        syncIdNeededForCompletion: SyncId? = nil,
        batchIndex: Int? = nil
    ) {
        self.clientTxId = clientTxId
        self.clientId = clientId
        self.modelName = modelName
        self.modelId = canonicalSyncModelId(modelId)
        self.action = action
        self.payload = canonicalSyncIdentityFields(payload)
        self.original = original.map(canonicalSyncIdentityFields)
        self.state = state
        self.createdAt = createdAt
        self.retryCount = retryCount
        self.lastError = lastError
        self.syncIdNeededForCompletion = syncIdNeededForCompletion
        self.batchIndex = batchIndex
    }
}

public struct TransactionBatch: Sendable {
    public let batchId: String
    public let transactions: [Transaction]
    public let createdAt: TimeInterval

    public init(batchId: String, transactions: [Transaction], createdAt: TimeInterval) {
        self.batchId = batchId
        self.transactions = transactions
        self.createdAt = createdAt
    }
}

public struct TransactionResult: Sendable {
    public let clientTxId: String
    public let success: Bool
    public let syncId: SyncId?
    public let error: String?

    public init(clientTxId: String, success: Bool, syncId: SyncId?, error: String?) {
        self.clientTxId = clientTxId
        self.success = success
        self.syncId = syncId
        self.error = error
    }
}

public struct MutateResult: Sendable {
    public let success: Bool
    public let lastSyncId: SyncId
    public let results: [TransactionResult]

    public init(success: Bool, lastSyncId: SyncId, results: [TransactionResult]) {
        self.success = success
        self.lastSyncId = lastSyncId
        self.results = results
    }
}

// MARK: - Storage Metadata

public struct StorageMeta: Sendable {
    public var lastSyncId: SyncId
    public var firstSyncId: SyncId?
    public var subscribedGroups: [String]
    public var clientId: String
    public var bootstrapComplete: Bool
    public var groupChangePending: Bool
    public var privacyWithheldTransactionIds: [String]
    public var schemaHash: String?
    public var databaseVersion: Int?
    public var lastSyncAt: TimeInterval?

    public init(
        lastSyncId: SyncId,
        firstSyncId: SyncId? = nil,
        subscribedGroups: [String],
        clientId: String,
        bootstrapComplete: Bool,
        groupChangePending: Bool = false,
        privacyWithheldTransactionIds: [String] = [],
        schemaHash: String? = nil,
        databaseVersion: Int? = nil,
        lastSyncAt: TimeInterval? = nil
    ) {
        self.lastSyncId = lastSyncId
        self.firstSyncId = firstSyncId
        self.subscribedGroups = subscribedGroups
        self.clientId = clientId
        self.bootstrapComplete = bootstrapComplete
        self.groupChangePending = groupChangePending
        self.privacyWithheldTransactionIds = privacyWithheldTransactionIds
        self.schemaHash = schemaHash
        self.databaseVersion = databaseVersion
        self.lastSyncAt = lastSyncAt
    }

    public static func empty(clientId: String) -> StorageMeta {
        StorageMeta(
            lastSyncId: zeroSyncId,
            subscribedGroups: [],
            clientId: clientId,
            bootstrapComplete: false
        )
    }
}

public struct StoredModelRecord: @unchecked Sendable {
    public let modelName: String
    public let id: String
    public let data: [String: Any]

    public init(modelName: String, id: String, data: [String: Any]) {
        self.modelName = modelName
        self.id = id
        self.data = data
    }
}

// MARK: - Batch Operation

public enum BatchOperation: @unchecked Sendable {
    case put(modelName: String, id: String, data: [String: Any])
    case delete(modelName: String, id: String)
}

// MARK: - Sync Events

public enum SyncClientEvent: @unchecked Sendable {
    case syncStart
    case localDataReady
    case syncComplete(lastSyncId: SyncId)
    case syncError(any Error)
    case stateChange(SyncClientState)
    case connectionChange(ConnectionState)
    case outboxChange(pendingCount: Int)
    case modelChange(modelName: String, modelId: String, action: String)
}

// MARK: - SyncModel Protocol

public protocol SyncModel {
    static var modelName: String { get }
    nonisolated var id: String { get }
    init(from dictionary: [String: Any]) throws
    func toDictionary() -> [String: Any]
    func applying(changes: [String: Any]) -> Self
}

// MARK: - Schema Description (feeds `SyncModelStore.registrationsHash`)

/// One field's contribution to the schema hash: the wire key, plus a name for
/// the codec that encodes and decodes it.
///
/// `codec` is an opaque identity, not a type: two fields share a codec name only
/// when the same code round-trips them. A record family that decodes `Double?`
/// epoch milliseconds and one that decodes ISO-8601 strings must not reuse a
/// name, or a client that switched between them would keep its stale rows.
public struct SyncSchemaField: Sendable, Equatable {
    public let name: String
    public let codec: String

    public init(name: String, codec: String) {
        self.name = name
        self.codec = codec
    }
}

/// Opt-in, decoding-relevant description of a model's fields.
///
/// `SyncModel` alone carries no field metadata, so a model that does not adopt
/// this contributes only its name to ``SyncModelStore/registrationsHash`` and a
/// change *within* it goes undetected. Adopt it on every registered model.
///
/// Describe only what can corrupt a decode. Indexes, load strategies and other
/// fetch-policy metadata belong nowhere near this list: they change which rows
/// are present, never how a persisted row is read back.
public protocol SchemaDescribedModel {
    static var syncSchemaFields: [SyncSchemaField] { get }
}

// MARK: - Transaction Factories

public func createTransaction(
    clientId: String,
    modelName: String,
    modelId: String,
    action: TransactionAction,
    payload: [String: Any],
    original: [String: Any]? = nil
) -> Transaction {
    Transaction(
        clientTxId: UUID().uuidString,
        clientId: clientId,
        modelName: modelName,
        modelId: modelId,
        action: action,
        payload: payload,
        original: original,
        state: .queued,
        createdAt: Date().timeIntervalSince1970 * 1000.0,
        retryCount: 0
    )
}

public func createUpdateTransaction(
    clientId: String,
    modelName: String,
    modelId: String,
    changes: [String: Any],
    original: [String: Any]
) -> Transaction {
    createTransaction(
        clientId: clientId,
        modelName: modelName,
        modelId: modelId,
        action: .update,
        payload: changes,
        original: original
    )
}

public func createInsertTransaction(
    clientId: String,
    modelName: String,
    modelId: String,
    data: [String: Any]
) -> Transaction {
    createTransaction(
        clientId: clientId,
        modelName: modelName,
        modelId: modelId,
        action: .insert,
        payload: data
    )
}

public func createDeleteTransaction(
    clientId: String,
    modelName: String,
    modelId: String,
    original: [String: Any]
) -> Transaction {
    createTransaction(
        clientId: clientId,
        modelName: modelName,
        modelId: modelId,
        action: .delete,
        payload: [:],
        original: original
    )
}

public func createArchiveTransaction(
    clientId: String,
    modelName: String,
    modelId: String,
    archivedAt: Double? = nil,
    original: [String: Any]? = nil
) -> Transaction {
    let now = archivedAt ?? Date().timeIntervalSince1970 * 1000.0
    return createTransaction(
        clientId: clientId,
        modelName: modelName,
        modelId: modelId,
        action: .archive,
        payload: ["archivedAt": now],
        original: original
    )
}

public func createUnarchiveTransaction(
    clientId: String,
    modelName: String,
    modelId: String,
    original: [String: Any]? = nil
) -> Transaction {
    createTransaction(
        clientId: clientId,
        modelName: modelName,
        modelId: modelId,
        action: .unarchive,
        payload: ["archivedAt": NSNull()],
        original: original
    )
}

public func createTransactionBatch(_ transactions: [Transaction]) -> TransactionBatch {
    TransactionBatch(
        batchId: UUID().uuidString,
        transactions: transactions,
        createdAt: Date().timeIntervalSince1970 * 1000.0
    )
}

/// Normalizes Archive (A) and Unarchive (V) to Update (U) for conflict detection.
public func normalizeActionForRebase(_ action: String) -> String? {
    switch action {
    case "I": "I"
    case "U", "A", "V": "U"
    case "D": "D"
    default: nil
    }
}
