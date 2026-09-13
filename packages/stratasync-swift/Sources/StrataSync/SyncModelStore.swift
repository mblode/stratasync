import Foundation

@MainActor
@Observable
public final class SyncModelStore {
    private var maps: [String: AnyIdentityMap] = [:]
    private var schemaFields: [String: [SyncSchemaField]] = [:]

    public private(set) var supportedModelNames: [String] = []

    public init() {}

    @discardableResult
    public func register<T: SyncModel>(_ type: T.Type) -> IdentityMap<T> {
        if let existing = maps[T.modelName] {
            guard let typedExisting = existing as? IdentityMap<T> else {
                preconditionFailure("Model '\(T.modelName)' was already registered with a different type")
            }
            return typedExisting
        }

        let map = IdentityMap<T>()
        maps[T.modelName] = map
        if let described = T.self as? any SchemaDescribedModel.Type {
            schemaFields[T.modelName] = described.syncSchemaFields
        }
        supportedModelNames.append(T.modelName)
        return map
    }

    public func map<T: SyncModel>(for type: T.Type) -> IdentityMap<T>? {
        maps[T.modelName] as? IdentityMap<T>
    }

    /// A stable 16-character hex hash of everything that can change how a
    /// persisted row decodes: every registered model name, each model's field
    /// names, and each field's codec.
    ///
    /// Pass this as `SyncEngine`'s `schemaHash` so a shipped schema change
    /// forces a full re-bootstrap instead of decoding last version's rows with
    /// this version's decoder. It is compared only against the hash this client
    /// persisted last run, never against the server's, so it does not need to
    /// match the TypeScript engine's hash — only its granularity rule matters.
    ///
    /// **The rule: hash what can corrupt a decode, nothing else.** Field names
    /// and codecs qualify. Indexes, load strategies, partial-load modes and the
    /// rest of the fetch-policy metadata do not — they decide which rows are
    /// fetched, never how a row already on disk is read back — so hashing them
    /// would spend a full re-bootstrap on a change no client can be hurt by.
    /// The TypeScript `computeSchemaHash` covers the whole registry snapshot and
    /// over-invalidates for exactly that reason; do not copy it here.
    ///
    /// A model that does not conform to ``SchemaDescribedModel`` contributes
    /// only its name, so a field change inside it stays invisible. Registering
    /// one is a silent hole in this hash.
    ///
    /// Adopting this on an install that previously passed no hash — or widening
    /// it from a coarser one — triggers one full re-bootstrap per client, since
    /// the persisted hash differs. That is the whole cost: the bootstrap path is
    /// the same one a first launch takes.
    public var registrationsHash: String {
        // FNV-1a 64: deterministic across runs and platforms, no dependency.
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        func absorb(_ token: String) {
            for byte in Array(token.utf8) + [0] {
                hash ^= UInt64(byte)
                hash &*= 0x0000_0100_0000_01b3
            }
        }

        for name in supportedModelNames.sorted() {
            absorb(name)
            let fields = schemaFields[name, default: []].sorted { $0.name < $1.name }
            // The count frames the field list, so a field name can never be
            // mistaken for the next model's name.
            absorb(String(fields.count))
            for field in fields {
                absorb(field.name)
                absorb(field.codec)
            }
        }

        let hex = String(hash, radix: 16)
        return String(repeating: "0", count: 16 - hex.count) + hex
    }

    public func clearAll() {
        for map in maps.values {
            map.clear()
        }
    }

    public var hasLoadedData: Bool {
        maps.values.contains { !$0.allDictionaries().isEmpty }
    }

    public func hasPersistedData(storage: StorageAdapter) async -> Bool {
        for modelName in supportedModelNames {
            if !(await storage.getAll(modelName: modelName)).isEmpty {
                return true
            }
        }
        return false
    }

    public func hydrateFromStorage(_ storage: StorageAdapter) async throws {
        var records: [StoredModelRecord] = []
        for modelName in supportedModelNames {
            for item in await storage.getAll(modelName: modelName) {
                guard let id = item["id"] as? String else {
                    throw SyncModelStoreError.missingModelId(modelName: modelName)
                }
                records.append(StoredModelRecord(modelName: modelName, id: id, data: item))
            }
        }
        try replaceAll(with: records)
    }

    public func applyPendingOutbox(_ outbox: [Transaction]) {
        for tx in outbox where tx.state != .completed && tx.state != .failed {
            switch tx.action {
            case .insert:
                set(modelName: tx.modelName, data: tx.payload)
            case .delete:
                delete(modelName: tx.modelName, id: tx.modelId)
            default:
                update(modelName: tx.modelName, id: tx.modelId, changes: tx.payload)
            }
        }
    }

    public func set(modelName: String, data: [String: Any]) {
        guard let map = maps[modelName], let id = data["id"] as? String else { return }
        try? map.setFromDictionary(id, data: data)
    }

    public func merge(modelName: String, id: String, data: [String: Any]) {
        guard let map = maps[modelName] else { return }
        try? map.mergeFromDictionary(id, data: data)
    }

    public func update(modelName: String, id: String, changes: [String: Any]) {
        guard let map = maps[modelName] else { return }
        map.updateFromDictionary(id, changes: changes)
    }

    public func delete(modelName: String, id: String) {
        guard let map = maps[modelName] else { return }
        map.deleteById(id)
    }

    public func snapshot(modelName: String, id: String) -> [String: Any]? {
        maps[modelName]?.snapshotById(id)
    }

    func validate(modelName: String, data: [String: Any]) throws {
        guard let map = maps[modelName] else { return }
        do {
            try map.validateDictionary(data)
        } catch {
            throw SyncModelStoreError.invalidModel(
                modelName: modelName,
                modelId: data["id"] as? String,
                underlying: error
            )
        }
    }

    func replaceAll(with records: [StoredModelRecord]) throws {
        for record in records {
            try validate(modelName: record.modelName, data: record.data)
        }

        try batchAll {
            clearAll()
            for record in records {
                guard let map = maps[record.modelName] else { continue }
                try map.setFromDictionary(record.id, data: record.data)
            }
        }
    }

    /// Applies `work` as one notification per model map.
    ///
    /// Safe to open across every map even when only one of them is touched: a
    /// map that records no mutation notifies nobody when its batch closes (see
    /// `IdentityMap.endBatch`). Without that, a delta touching one model would
    /// invalidate every view in the app.
    func batchAll<Result>(_ work: () throws -> Result) rethrows -> Result {
        let openMaps = Array(maps.values)
        for map in openMaps {
            map.beginBatch()
        }
        defer {
            for map in openMaps {
                map.endBatch()
            }
        }
        return try work()
    }
}

enum SyncModelStoreError: Error, LocalizedError {
    case invalidModel(modelName: String, modelId: String?, underlying: Error)
    case missingModelId(modelName: String)

    var errorDescription: String? {
        switch self {
        case .invalidModel(let modelName, let modelId, let underlying):
            "Invalid \(modelName) \(modelId ?? "<missing id>"): \(underlying.localizedDescription)"
        case .missingModelId(let modelName):
            "Invalid \(modelName): missing id"
        }
    }
}
