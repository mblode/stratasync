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

/**
 * A patch describing the rebased `original` snapshot for a pending transaction.
 */
export interface RebaseOriginalPatch {
  /** The pending transaction whose original should be updated */
  clientTxId: string;
  /** The new original snapshot */
  original: Record<string, unknown>;
}

/**
 * Returns true for the action types whose data should be folded into a pending
 * transaction's `original` snapshot during rebase.
 */
const shouldRebaseAction = (action: SyncAction["action"]): boolean =>
  action === "U" || action === "I" || action === "V" || action === "C";

const buildActionsByKey = (
  actions: SyncAction[]
): Map<string, SyncAction[]> => {
  const actionsByKey = new Map<string, SyncAction[]>();
  for (const action of actions) {
    const key = `${action.modelName}:${action.modelId}`;
    const existing = actionsByKey.get(key) ?? [];
    existing.push(action);
    actionsByKey.set(key, existing);
  }
  return actionsByKey;
};

const getUpdatedOriginal = (
  tx: Transaction,
  related: SyncAction[]
): Record<string, unknown> | null => {
  const original = { ...tx.original };
  let updated = false;

  for (const action of related) {
    if (!shouldRebaseAction(action.action)) {
      continue;
    }
    for (const field of Object.keys(tx.payload)) {
      if (field in action.data) {
        original[field] = action.data[field];
        updated = true;
      }
    }
  }

  return updated ? original : null;
};

/**
 * Computes the rebased `original` snapshots for pending update-like
 * transactions against a batch of server actions.
 *
 * Pure: returns the patches to apply rather than mutating/persisting. Only
 * U/A/V transactions whose tracked fields were touched by the server produce a
 * patch.
 */
export const rebaseOriginals = (
  pending: Transaction[],
  actions: SyncAction[]
): RebaseOriginalPatch[] => {
  const actionsByKey = buildActionsByKey(actions);
  const patches: RebaseOriginalPatch[] = [];

  for (const tx of pending) {
    if (tx.action !== "U" && tx.action !== "A" && tx.action !== "V") {
      continue;
    }
    const key = `${tx.modelName}:${tx.modelId}`;
    const related = actionsByKey.get(key);
    if (!related) {
      continue;
    }
    const updatedOriginal = getUpdatedOriginal(tx, related);
    if (!updatedOriginal) {
      continue;
    }
    patches.push({ clientTxId: tx.clientTxId, original: updatedOriginal });
  }

  return patches;
};

/**
 * The effect of resolving a single rebase conflict, as a discriminated union.
 *
 * - `drop-local`: the local optimistic transaction loses; remove it (server-wins).
 * - `patch-original`: the local transaction wins/merges; replace its `original`
 *   snapshot with the merged value.
 * - `none`: no state change is required for this conflict.
 *
 * "manual" resolution is coerced to "server-wins" (drop-local) — manual
 * intervention is not supported at this layer.
 */
export type ConflictEffect =
  | { kind: "drop-local" }
  | { kind: "patch-original"; original: Record<string, unknown> }
  | { kind: "none" };

/**
 * Pure resolution of a rebase conflict into the effect the caller must apply.
 *
 * Mirrors the orchestrator's previous `handleConflict` branching without any
 * storage or identity-map side effects.
 */
export const resolveConflictEffect = (
  conflict: RebaseConflict
): ConflictEffect => {
  const { localTransaction: tx } = conflict;
  const resolution =
    conflict.resolution === "manual" ? "server-wins" : conflict.resolution;

  if (resolution === "server-wins") {
    return { kind: "drop-local" };
  }

  if (
    (resolution === "client-wins" || resolution === "merge") &&
    (tx.action === "U" || tx.action === "A" || tx.action === "V")
  ) {
    return {
      kind: "patch-original",
      original: {
        ...tx.original,
        ...conflict.serverAction.data,
      },
    };
  }

  return { kind: "none" };
};
