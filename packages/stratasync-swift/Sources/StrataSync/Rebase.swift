import Foundation

// MARK: - Rebase Types

struct RebaseResult {
    var pending: [Transaction]
    var confirmed: [Transaction]
    var conflicts: [RebaseConflict]
}

struct RebaseConflict {
    let localTransaction: Transaction
    let serverAction: SyncAction
    let conflictType: ConflictType
    let resolution: ConflictResolution
}

enum ConflictType: String {
    case updateUpdate = "update-update"
    case updateDelete = "update-delete"
    case deleteUpdate = "delete-update"
    case insertInsert = "insert-insert"
}

enum ConflictResolution: String {
    case serverWins = "server-wins"
    case clientWins = "client-wins"
    case merge
}

// MARK: - Rebase Algorithm

/// Rebases pending transactions against server deltas.
///
/// 1. For each server action, check if we have a pending transaction for the same model/id
/// 2. If the server action is our own transaction (matched by clientTxId), mark as confirmed
/// 3. If the server action conflicts with our pending transaction, detect the conflict type
/// 4. Apply the appropriate resolution strategy
func rebaseTransactions(
    pending: [Transaction],
    serverActions: [SyncAction],
    clientId: String,
    defaultResolution: ConflictResolution? = nil,
    fieldLevelConflicts: Bool = true
) -> RebaseResult {
    var result = RebaseResult(pending: [], confirmed: [], conflicts: [])

    // Index pending transactions by model+id for fast lookup
    var pendingByKey: [String: [Transaction]] = [:]
    for tx in pending {
        let key = "\(tx.modelName):\(tx.modelId)"
        pendingByKey[key, default: []].append(tx)
    }

    // Track which transactions have been processed
    var processed = Set<String>()

    // Process each server action
    for action in serverActions {
        let key = "\(action.modelName):\(action.modelId)"
        let relatedTxs = pendingByKey[key] ?? []

        for tx in relatedTxs {
            if processed.contains(tx.clientTxId) {
                continue
            }

            // Check if this server action is our own transaction
            if action.clientTxId == tx.clientTxId && action.clientId == clientId {
                result.confirmed.append(tx)
                processed.insert(tx.clientTxId)
                continue
            }

            // Check for conflicts
            if let conflict = detectConflict(
                tx: tx,
                action: action,
                defaultResolution: defaultResolution,
                fieldLevelConflicts: fieldLevelConflicts
            ) {
                result.conflicts.append(conflict)
                processed.insert(tx.clientTxId)
            }
        }
    }

    // Remaining unprocessed transactions stay pending
    for tx in pending {
        if !processed.contains(tx.clientTxId) {
            result.pending.append(tx)
        }
    }

    return result
}

// MARK: - Conflict Detection

private func detectConflict(
    tx: Transaction,
    action: SyncAction,
    defaultResolution: ConflictResolution?,
    fieldLevelConflicts: Bool
) -> RebaseConflict? {
    guard let normalizedServer = normalizeActionForRebase(action.action.rawValue),
          let normalizedLocal = normalizeActionForRebase(tx.action.rawValue) else {
        return nil
    }

    let conflictType: ConflictType

    if normalizedLocal == "I" && normalizedServer == "I" {
        conflictType = .insertInsert
    } else if normalizedLocal == "D" && normalizedServer == "U" {
        conflictType = .deleteUpdate
    } else if normalizedLocal == "U" && normalizedServer == "D" {
        conflictType = .updateDelete
    } else if normalizedLocal == "U" && normalizedServer == "U" {
        // Check for field-level conflicts
        if fieldLevelConflicts {
            let localFields = Set(tx.payload.keys)
            let serverFields = Set(action.data.keys)
            let hasOverlap = !localFields.isDisjoint(with: serverFields)
            if !hasOverlap {
                return nil // No overlapping fields, can merge
            }
        }
        conflictType = .updateUpdate
    } else {
        return nil
    }

    let resolution = resolveConflict(defaultResolution: defaultResolution)

    return RebaseConflict(
        localTransaction: tx,
        serverAction: action,
        conflictType: conflictType,
        resolution: resolution
    )
}

private func resolveConflict(defaultResolution: ConflictResolution?) -> ConflictResolution {
    // The live pipeline always passes an explicit resolution (server-wins).
    // Fall back to server-wins for any caller that doesn't.
    defaultResolution ?? .serverWins
}
