import type { Transaction } from "../transaction/types.js";
import type { SyncAction } from "./types.js";

/**
 * Result of rebasing pending transactions against server deltas
 */
export interface RebaseResult {
  /** Transactions that should remain pending */
  pending: Transaction[];
  /** Transactions that were confirmed by the server */
  confirmed: Transaction[];
  /** Transactions that conflict with server changes */
  conflicts: RebaseConflict[];
}

/**
 * A conflict between a pending transaction and a server change
 */
export interface RebaseConflict {
  /** The local pending transaction */
  localTransaction: Transaction;
  /** The conflicting server action */
  serverAction: SyncAction;
  /** Type of conflict */
  conflictType: ConflictType;
  /** Suggested resolution */
  resolution: ConflictResolution;
}

/**
 * Types of conflicts that can occur
 */
type ConflictType =
  // Both modified the same fields
  | "update-update"
  // Local update, server deleted
  | "update-delete"
  // Local delete, server updated
  | "delete-update"
  // Both inserted same ID (rare)
  | "insert-insert";

/**
 * Possible conflict resolutions
 */
export type ConflictResolution =
  // Accept server version
  | "server-wins"
  // Re-apply client change
  | "client-wins"
  // Merge both changes (field-level)
  | "merge"
  // Requires user intervention
  | "manual";

/**
 * Options for rebase operation
 */
export interface RebaseOptions {
  /** Client ID to identify own transactions */
  clientId: string;
  /** Default conflict resolution strategy */
  defaultResolution?: ConflictResolution;
  /** Field-level conflict detection */
  fieldLevelConflicts?: boolean;
}

/**
 * Normalizes Archive (A) and Unarchive (V) actions to Update (U)
 * since they are semantically update-like operations.
 */
const normalizeAction = (action: string): "I" | "U" | "D" | null => {
  switch (action) {
    case "I": {
      return "I";
    }
    case "U":
    case "A":
    case "V": {
      return "U";
    }
    case "D": {
      return "D";
    }
    default: {
      return null;
    }
  }
};

const getLocalConflictFields = (tx: Transaction): string[] => {
  if (tx.action === "A" || tx.action === "V") {
    return ["archivedAt"];
  }

  return Object.keys(tx.payload);
};

const getServerConflictFields = (action: SyncAction): string[] => {
  if (action.action === "A" || action.action === "V") {
    const dataKeys = Object.keys(action.data).filter(
      (key) => key !== "archivedAt"
    );
    return ["archivedAt", ...dataKeys];
  }

  return Object.keys(action.data);
};

/**
 * Determines the resolution strategy for a conflict
 */
const resolveConflict = (
  conflictType: ConflictType,
  options: RebaseOptions
): ConflictResolution => {
  if (options.defaultResolution) {
    return options.defaultResolution;
  }

  // insert-insert is rare (likely a bug) and requires manual resolution.
  // All other conflict types default to server-wins (last-write-wins).
  if (conflictType === "insert-insert") {
    return "manual";
  }

  return "server-wins";
};

/**
 * Detects if there's a conflict between a local transaction and server action
 */
const detectConflict = (
  tx: Transaction,
  action: SyncAction,
  options: RebaseOptions
): RebaseConflict | null => {
  const normalizedServer = normalizeAction(action.action);
  const normalizedLocal = normalizeAction(tx.action);

  if (!(normalizedServer && normalizedLocal)) {
    return null;
  }

  // modelName and modelId match is guaranteed by the caller's key-based lookup
  let conflictType: ConflictType;

  if (normalizedLocal === "I" && normalizedServer === "I") {
    conflictType = "insert-insert";
  } else if (normalizedLocal === "D" && normalizedServer === "U") {
    conflictType = "delete-update";
  } else if (normalizedLocal === "U" && normalizedServer === "D") {
    conflictType = "update-delete";
  } else if (normalizedLocal === "U" && normalizedServer === "U") {
    // Check for field-level conflicts
    if (options.fieldLevelConflicts) {
      const localFields = getLocalConflictFields(tx);
      const serverFields = getServerConflictFields(action);
      const overlap = localFields.some((f) => serverFields.includes(f));
      if (!overlap) {
        // No overlapping fields, can merge
        return null;
      }
    }
    conflictType = "update-update";
  } else {
    // No conflict for other combinations
    return null;
  }

  // Determine resolution
  const resolution = resolveConflict(conflictType, options);

  return {
    conflictType,
    localTransaction: tx,
    resolution,
    serverAction: action,
  };
};

/**
 * Rebases pending transactions against server deltas
 *
 * This is the core algorithm for handling concurrent edits:
 * 1. For each server action, check if we have a pending transaction for the same model/id
 * 2. If the server action is our own transaction (matched by clientTxId), mark as confirmed
 * 3. If the server action conflicts with our pending transaction, detect the conflict type
 * 4. Apply the appropriate resolution strategy
 */
export const rebaseTransactions = (
  pending: Transaction[],
  serverActions: SyncAction[],
  options: RebaseOptions
): RebaseResult => {
  const result: RebaseResult = {
    confirmed: [],
    conflicts: [],
    pending: [],
  };

  // Index pending transactions by model+id for fast lookup
  const pendingByKey = new Map<string, Transaction[]>();
  for (const tx of pending) {
    const key = `${tx.modelName}:${tx.modelId}`;
    const existing = pendingByKey.get(key) ?? [];
    existing.push(tx);
    pendingByKey.set(key, existing);
  }

  // Track which transactions have been processed
  const processed = new Set<string>();

  // Process each server action
  for (const action of serverActions) {
    const key = `${action.modelName}:${action.modelId}`;
    const relatedTxs = pendingByKey.get(key) ?? [];
    const ownEcho = relatedTxs.find(
      (tx) =>
        !processed.has(tx.clientTxId) &&
        action.clientTxId === tx.clientTxId &&
        action.clientId === options.clientId
    );

    if (ownEcho) {
      result.confirmed.push(ownEcho);
      processed.add(ownEcho.clientTxId);
      continue;
    }

    for (const tx of relatedTxs) {
      if (processed.has(tx.clientTxId)) {
        continue;
      }

      // Check for conflicts
      const conflict = detectConflict(tx, action, options);
      if (conflict) {
        result.conflicts.push(conflict);
        processed.add(tx.clientTxId);
      }
    }
  }

  // Remaining unprocessed transactions stay pending
  for (const tx of pending) {
    if (!processed.has(tx.clientTxId)) {
      result.pending.push(tx);
    }
  }

  return result;
};
