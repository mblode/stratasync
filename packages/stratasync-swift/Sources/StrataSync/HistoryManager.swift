import Foundation

/// Undo/redo history manager mirroring the web `sync-client` HistoryManager.
///
/// Uses a dual-stack architecture with inverse operation tracking.
/// Groups related mutations into single undo steps via `runAsGroup`.
@MainActor
@Observable
final class HistoryManager {

    // MARK: - Types

    /// A single reversible operation.
    struct HistoryOperation {
        /// "I" (insert), "D" (delete), "U" (update), "A" (archive), "V" (unarchive)
        let action: String
        let modelName: String
        let modelId: String
        let payload: [String: Any]
        /// Snapshot of the model before mutation, used for restoring state on undo.
        let originalState: [String: Any]?

        init(
            action: String,
            modelName: String,
            modelId: String,
            payload: [String: Any],
            originalState: [String: Any]? = nil
        ) {
            self.action = action
            self.modelName = modelName
            self.modelId = modelId
            self.payload = payload
            self.originalState = originalState
        }
    }

    /// A single undo/redo entry: the operation and its inverse.
    struct HistoryEntry {
        let undo: HistoryOperation
        let redo: HistoryOperation
    }

    /// A group of related entries that should undo/redo together.
    struct HistoryGroup {
        var entries: [HistoryEntry]
        var transactionIds: [String]
    }

    // MARK: - State

    private(set) var undoStack: [HistoryGroup] = []
    private(set) var redoStack: [HistoryGroup] = []
    private var captureStack: [HistoryGroup] = []
    private(set) var suppressHistory = false

    var canUndo: Bool { !undoStack.isEmpty }
    var canRedo: Bool { !redoStack.isEmpty }

    /// The mutate function injected by SyncClient to apply operations.
    @ObservationIgnored
    var applyMutation: ((_ action: String, _ modelName: String, _ modelId: String, _ payload: [String: Any]) async throws -> String?)?

    // MARK: - Recording

    /// Record a history entry. If inside a group, appends to the current group; otherwise creates a standalone group.
    func record(entry: HistoryEntry, transactionId: String? = nil) {
        guard !suppressHistory else { return }

        if !captureStack.isEmpty {
            captureStack[captureStack.count - 1].entries.append(entry)
            if let txId = transactionId {
                captureStack[captureStack.count - 1].transactionIds.append(txId)
            }
        } else {
            var group = HistoryGroup(entries: [entry], transactionIds: [])
            if let txId = transactionId {
                group.transactionIds.append(txId)
            }
            undoStack.append(group)
            redoStack.removeAll()
        }
    }

    /// Build a standard history entry based on action type.
    func buildEntry(
        action: String,
        modelName: String,
        modelId: String,
        payload: [String: Any],
        originalState: [String: Any]?
    ) -> HistoryEntry {
        let undoOp: HistoryOperation
        let redoOp: HistoryOperation

        switch action {
        case "I": // Insert → undo is delete
            undoOp = HistoryOperation(action: "D", modelName: modelName, modelId: modelId, payload: [:])
            redoOp = HistoryOperation(action: "I", modelName: modelName, modelId: modelId, payload: payload)
        case "D": // Delete → undo is insert with original state
            undoOp = HistoryOperation(action: "I", modelName: modelName, modelId: modelId, payload: originalState ?? payload)
            redoOp = HistoryOperation(action: "D", modelName: modelName, modelId: modelId, payload: [:])
        case "A": // Archive → undo is unarchive
            undoOp = HistoryOperation(action: "V", modelName: modelName, modelId: modelId, payload: [:], originalState: originalState)
            redoOp = HistoryOperation(action: "A", modelName: modelName, modelId: modelId, payload: payload)
        case "V": // Unarchive → undo is archive
            undoOp = HistoryOperation(action: "A", modelName: modelName, modelId: modelId, payload: [:], originalState: originalState)
            redoOp = HistoryOperation(action: "V", modelName: modelName, modelId: modelId, payload: payload)
        default: // Update → undo restores original, redo re-applies
            undoOp = HistoryOperation(action: "U", modelName: modelName, modelId: modelId, payload: originalState ?? [:])
            redoOp = HistoryOperation(action: "U", modelName: modelName, modelId: modelId, payload: payload)
        }

        return HistoryEntry(undo: undoOp, redo: redoOp)
    }

    // MARK: - Grouping

    /// Run a closure that may produce multiple mutations, all grouped as one undo step.
    func runAsGroup<T>(_ work: () async throws -> T) async rethrows -> T {
        captureStack.append(HistoryGroup(entries: [], transactionIds: []))

        var didThrow = false
        defer {
            if let group = captureStack.popLast(), !didThrow, !group.entries.isEmpty {
                if captureStack.isEmpty {
                    undoStack.append(group)
                    redoStack.removeAll()
                } else {
                    // Nested group: merge into parent.
                    captureStack[captureStack.count - 1].entries.append(contentsOf: group.entries)
                    captureStack[captureStack.count - 1].transactionIds.append(contentsOf: group.transactionIds)
                }
            }
        }

        do {
            return try await work()
        } catch {
            didThrow = true
            throw error
        }
    }

    // MARK: - Undo / Redo

    /// Undo the most recent group of operations.
    func undo() async {
        guard let group = undoStack.popLast(), let applyMutation else { return }

        suppressHistory = true
        defer { suppressHistory = false }

        var redoGroup = HistoryGroup(entries: [], transactionIds: [])

        // Apply undo operations in reverse order
        for entry in group.entries.reversed() {
            let op = entry.undo
            do {
                let txId = try await applyMutation(op.action, op.modelName, op.modelId, op.payload)
                redoGroup.entries.insert(entry, at: 0)
                if let txId {
                    redoGroup.transactionIds.append(txId)
                }
            } catch {
                // Partial failure: push remaining back to undo stack
                break
            }
        }

        if !redoGroup.entries.isEmpty {
            redoStack.append(redoGroup)
        }
    }

    /// Redo the most recently undone group of operations.
    func redo() async {
        guard let group = redoStack.popLast(), let applyMutation else { return }

        suppressHistory = true
        defer { suppressHistory = false }

        var undoGroup = HistoryGroup(entries: [], transactionIds: [])

        // Apply redo operations in forward order
        for entry in group.entries {
            let op = entry.redo
            do {
                let txId = try await applyMutation(op.action, op.modelName, op.modelId, op.payload)
                undoGroup.entries.append(entry)
                if let txId {
                    undoGroup.transactionIds.append(txId)
                }
            } catch {
                break
            }
        }

        if !undoGroup.entries.isEmpty {
            undoStack.append(undoGroup)
        }
    }

    // MARK: - Invalidation

    /// Remove any groups containing the given transaction ID (e.g. when server rejects a mutation).
    func removeByTxId(_ txId: String) {
        undoStack.removeAll { $0.transactionIds.contains(txId) }
        redoStack.removeAll { $0.transactionIds.contains(txId) }
    }

    /// Clear all history.
    func clear() {
        undoStack.removeAll()
        redoStack.removeAll()
        captureStack.removeAll()
    }
}
