import Foundation

// MARK: - Type Erasure

@MainActor
public protocol AnyIdentityMap: AnyObject {
    func setFromDictionary(_ id: String, data: [String: Any]) throws
    func mergeFromDictionary(_ id: String, data: [String: Any]) throws
    func validateDictionary(_ data: [String: Any]) throws
    func updateFromDictionary(_ id: String, changes: [String: Any])
    func deleteById(_ id: String)
    func snapshotById(_ id: String) -> [String: Any]?
    func clear()
    func allDictionaries() -> [[String: Any]]
    func beginBatch()
    func endBatch()
}

// MARK: - Observation

/// Non-generic observation trigger for `IdentityMap`.
///
/// `@Observable` on a *generic* class makes its macro-generated property
/// accessors emit key paths that carry a generic-argument reference
/// (`\IdentityMap<T>._items`). Resolving such a key path at runtime can trip a
/// `_resolveKeyPathGenericArgReference` assertion (SIGTRAP) once the type is
/// instantiated across the StrataSync framework boundary. This mirrors the TS
/// engine, where `IdentityMap` delegates reactivity to an injected *non-generic*
/// `ObservableMap` rather than being observable itself: the observation lives
/// here, on a concrete type, so no generic key path is ever synthesized.
@MainActor
@Observable
final class IdentityMapObservation {
    /// Bumped on every content change; read to register a SwiftUI dependency
    /// on the whole map (`values` / `filter` / `find` / `items`).
    var revision: UInt64 = 0
}

/// Per-record observation box. Stored off `IdentityMapObservation` so creating
/// a box for a newly touched id does not invalidate other `get` callers.
@MainActor
@Observable
final class IdentityMapRecordObservation {
    var revision: UInt64 = 0
}

// MARK: - Identity Map

/// Per-model identity map.
/// Stores typed Swift structs and triggers SwiftUI updates when the dictionary
/// changes. Reactivity is delegated to a non-generic `IdentityMapObservation`
/// (see its docs) so the generic class itself is not `@Observable`.
/// `get` / `has` observe one record; `values` / `filter` / `find` / `items`
/// observe the whole map. Supports `batch()` to coalesce multiple mutations
/// into a single notification.
@MainActor
public final class IdentityMap<T: SyncModel> {
    /// The backing store. During a batch, mutations accumulate here and a single
    /// change is registered when the batch ends.
    private var _items: [String: T] = [:]
    private var batchDepth = 0
    private var isBatchDirty = false
    private var isBatching: Bool { batchDepth > 0 }

    /// Cached values array, invalidated on mutation.
    private var _cachedValues: [T]?

    /// Whole-map reactivity trigger. Reads of `values` / `filter` / `find` /
    /// `items` register a dependency; writes bump it.
    private let observation = IdentityMapObservation()

    /// Per-record boxes for `get` / `has`. Not an `@Observable` property: inserting
    /// a box must not invalidate every other record reader.
    private var recordObservations: [String: IdentityMapRecordObservation] = [:]
    private var dirtyRecordIds: Set<String> = []

    public init() {}

    /// Registers the caller (e.g. a SwiftUI view body) as a dependency of this
    /// map's contents. A no-op outside an observation-tracking scope.
    @inline(__always)
    private func trackAccess() {
        _ = observation.revision
    }

    @inline(__always)
    private func trackRecordAccess(_ id: String) {
        _ = recordObservation(for: id).revision
    }

    private func recordObservation(for id: String) -> IdentityMapRecordObservation {
        if let existing = recordObservations[id] {
            return existing
        }
        let created = IdentityMapRecordObservation()
        recordObservations[id] = created
        return created
    }

    private func bumpRecords(_ ids: some Sequence<String>) {
        for id in ids {
            recordObservation(for: id).revision &+= 1
        }
    }

    /// Records a content change: always invalidates the values cache, and
    /// notifies observers unless a batch is open.
    ///
    /// The cache invalidation is deliberately *outside* the batch check. It used
    /// to sit behind it, so a `values`/`filter`/`find` read taken part-way
    /// through a batch returned the pre-batch array while `_items` had already
    /// moved on.
    @inline(__always)
    private func markMutated(ids: [String]) {
        _cachedValues = nil
        if isBatching {
            isBatchDirty = true
            dirtyRecordIds.formUnion(ids)
        } else {
            observation.revision &+= 1
            bumpRecords(ids)
        }
    }

    /// The items dictionary. Reading registers a dependency on the map contents.
    public var items: [String: T] {
        trackAccess()
        return _items
    }

    /// Executes multiple identity map operations as a single atomic update.
    /// SwiftUI observers see only the final state, with no intermediate renders.
    ///
    /// Nesting is safe (a depth counter, not a flag, so an inner batch closing
    /// doesn't end the outer one), and a batch that mutates nothing notifies
    /// nobody — which is what makes it safe to open a batch on every model map
    /// when a delta only touches one of them.
    public func batch(_ work: () -> Void) {
        beginBatch()
        defer { endBatch() }
        work()
    }

    public func get(_ id: String) -> T? {
        let id = canonicalSyncModelId(id)
        trackRecordAccess(id)
        return _items[id]
    }

    public func has(_ id: String) -> Bool {
        let id = canonicalSyncModelId(id)
        trackRecordAccess(id)
        return _items[id] != nil
    }

    public func set(_ id: String, _ value: T) {
        let id = canonicalSyncModelId(id)
        _items[id] = value
        markMutated(ids: [id])
    }

    /// Merges data into an existing item or inserts a new one.
    public func merge(_ id: String, data: [String: Any]) throws {
        let id = canonicalSyncModelId(id)
        let data = canonicalSyncIdentityFields(data)
        if let existing = _items[id] {
            _items[id] = existing.applying(changes: data)
        } else {
            _items[id] = try T(from: data)
        }
        markMutated(ids: [id])
    }

    /// Updates an existing item with partial changes.
    public func update(_ id: String, changes: [String: Any]) {
        let id = canonicalSyncModelId(id)
        let changes = canonicalSyncIdentityFields(changes)
        guard let existing = _items[id] else { return }
        _items[id] = existing.applying(changes: changes)
        markMutated(ids: [id])
    }

    public func delete(_ id: String) {
        let id = canonicalSyncModelId(id)
        _items.removeValue(forKey: id)
        markMutated(ids: [id])
    }

    public func clear() {
        let ids = Set(_items.keys).union(recordObservations.keys)
        _items.removeAll()
        markMutated(ids: Array(ids))
    }

    public var values: [T] {
        trackAccess()
        if let cached = _cachedValues {
            return cached
        }
        let values = Array(_items.values)
        _cachedValues = values
        return values
    }

    public func filter(_ predicate: (T) -> Bool) -> [T] {
        trackAccess()
        return _items.values.filter(predicate)
    }

    public func find(_ predicate: (T) -> Bool) -> T? {
        trackAccess()
        return _items.values.first(where: predicate)
    }
}

extension IdentityMap {
    /// Batch boundaries as separate calls, so `SyncModelStore` can open one
    /// across every model map without knowing their element types.
    public func beginBatch() {
        batchDepth += 1
    }

    public func endBatch() {
        batchDepth -= 1
        guard batchDepth == 0, isBatchDirty else { return }
        isBatchDirty = false
        observation.revision &+= 1
        bumpRecords(dirtyRecordIds)
        dirtyRecordIds.removeAll()
    }
}

extension IdentityMap: AnyIdentityMap {
    public func validateDictionary(_ data: [String: Any]) throws {
        _ = try T(from: canonicalSyncIdentityFields(data))
    }

    public func setFromDictionary(_ id: String, data: [String: Any]) throws {
        let data = canonicalSyncIdentityFields(data)
        let item = try T(from: data)
        set(canonicalSyncModelId(id), item)
    }

    public func mergeFromDictionary(_ id: String, data: [String: Any]) throws {
        try merge(canonicalSyncModelId(id), data: canonicalSyncIdentityFields(data))
    }

    public func updateFromDictionary(_ id: String, changes: [String: Any]) {
        update(canonicalSyncModelId(id), changes: canonicalSyncIdentityFields(changes))
    }

    public func deleteById(_ id: String) {
        delete(canonicalSyncModelId(id))
    }

    public func snapshotById(_ id: String) -> [String: Any]? {
        get(canonicalSyncModelId(id))?.toDictionary()
    }

    public func allDictionaries() -> [[String: Any]] {
        values.map { $0.toDictionary() }
    }
}
