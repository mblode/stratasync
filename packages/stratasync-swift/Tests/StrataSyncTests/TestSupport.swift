import Foundation
import Testing
@testable import StrataSync

struct TestRecord: Identifiable, Sendable, SyncModel {
    let id: String
    var title: String
    var category: String
    var sortOrder: Double?
    var archivedAt: Double?

    static let modelName = "TestRecord"

    init(
        id: String,
        title: String,
        category: String,
        sortOrder: Double? = nil,
        archivedAt: Double? = nil
    ) {
        self.id = id
        self.title = title
        self.category = category
        self.sortOrder = sortOrder
        self.archivedAt = archivedAt
    }

    init(from dictionary: [String: Any]) throws {
        guard let id = dictionary["id"] as? String else {
            throw TestSupportError.missingField("id")
        }

        self.id = id
        self.title = dictionary["title"] as? String ?? ""
        self.category = dictionary["category"] as? String ?? ""
        self.sortOrder = dictionary["sortOrder"] as? Double
            ?? (dictionary["sortOrder"] as? Int).map(Double.init)
        self.archivedAt = dictionary["archivedAt"] as? Double
            ?? (dictionary["archivedAt"] as? Int).map(Double.init)
    }

    func toDictionary() -> [String: Any] {
        [
            "id": id,
            "title": title,
            "category": category,
            "sortOrder": sortOrder ?? NSNull(),
            "archivedAt": archivedAt ?? NSNull(),
        ]
    }

    func applying(changes: [String: Any]) -> TestRecord {
        var copy = self
        for (key, value) in changes {
            let isNull = value is NSNull
            switch key {
            case "title":
                copy.title = isNull ? "" : (value as? String ?? copy.title)
            case "category":
                copy.category = isNull ? "" : (value as? String ?? copy.category)
            case "sortOrder":
                if isNull {
                    copy.sortOrder = nil
                } else if let double = value as? Double {
                    copy.sortOrder = double
                } else if let int = value as? Int {
                    copy.sortOrder = Double(int)
                }
            case "archivedAt":
                if isNull {
                    copy.archivedAt = nil
                } else if let double = value as? Double {
                    copy.archivedAt = double
                } else if let int = value as? Int {
                    copy.archivedAt = Double(int)
                }
            default:
                break
            }
        }
        return copy
    }
}

enum TestSupportError: Error {
    case missingField(String)
    case storageFailure
}

final class MockStorageAdapter: StorageAdapter, @unchecked Sendable {
    private var models: [String: [String: [String: Any]]] = [:]
    private var outbox: [Transaction] = []
    private var meta: StorageMeta = .empty(clientId: "test-client")
    var beforeAddToOutbox: ((Transaction) async throws -> Void)?
    var beforeReplaceSnapshot: (([StoredModelRecord], StorageMeta) async throws -> Void)?
    var beforePut: ((String, String, [String: Any]) async throws -> Void)?
    var beforeSetMeta: ((StorageMeta) async throws -> Void)?

    func open() async throws {}
    func close() async throws {}

    func get(modelName: String, id: String) async -> [String: Any]? {
        models[modelName]?[id]
    }

    func getAll(modelName: String) async -> [[String: Any]] {
        guard let values = models[modelName]?.values else {
            return []
        }
        return Array(values)
    }

    /// Counts `writeBatch` calls, to assert delta writes stay batched.
    private(set) var writeBatchCalls = 0
    /// Counts single-row writes made outside a batch.
    private(set) var rowWriteCalls = 0

    private func writeRow(modelName: String, id: String, data: [String: Any]) {
        if models[modelName] == nil {
            models[modelName] = [:]
        }
        models[modelName]?[id] = data
    }

    func put(modelName: String, id: String, data: [String: Any]) async throws {
        try await beforePut?(modelName, id, data)
        rowWriteCalls += 1
        writeRow(modelName: modelName, id: id, data: data)
    }

    func delete(modelName: String, id: String) async throws {
        rowWriteCalls += 1
        models[modelName]?.removeValue(forKey: id)
    }

    func writeBatch(_ ops: [BatchOperation]) async throws {
        writeBatchCalls += 1
        for op in ops {
            switch op {
            case .put(let modelName, let id, let data):
                try await beforePut?(modelName, id, data)
                writeRow(modelName: modelName, id: id, data: data)
            case .delete(let modelName, let id):
                models[modelName]?.removeValue(forKey: id)
            }
        }
    }

    func getMeta() async -> StorageMeta {
        meta
    }

    func setMeta(_ meta: StorageMeta) async throws {
        try await beforeSetMeta?(meta)
        self.meta = meta
    }

    func getOutbox() async -> [Transaction] {
        outbox
    }

    func addToOutbox(_ tx: Transaction) async throws {
        try await beforeAddToOutbox?(tx)
        outbox.append(tx)
    }

    func removeFromOutbox(clientTxId: String) async throws {
        outbox.removeAll { $0.clientTxId == clientTxId }
    }

    func updateOutboxTransaction(clientTxId: String, updates: (inout Transaction) -> Void) async throws {
        guard let index = outbox.firstIndex(where: { $0.clientTxId == clientTxId }) else {
            return
        }
        updates(&outbox[index])
    }

    func replaceSnapshot(records: [StoredModelRecord], meta: StorageMeta) async throws {
        try await beforeReplaceSnapshot?(records, meta)
        var replacement: [String: [String: [String: Any]]] = [:]
        for record in records {
            replacement[record.modelName, default: [:]][record.id] = record.data
        }
        models = replacement
        self.meta = meta
    }

    func clear(preserveOutbox: Bool) async throws {
        models.removeAll()
        if !preserveOutbox {
            outbox.removeAll()
        }
    }
}
