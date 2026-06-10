import type { Transaction } from "@stratasync/core";
import {
  createArchivePayload,
  createUnarchivePatch,
  readArchivedAt,
} from "@stratasync/core";

import type { IdentityMapRegistry } from "../identity-map.js";

/**
 * Touches each pending transaction's identity-map target so MobX observers that
 * read the slot become subscribed before the batch mutates it.
 */
export const touchPendingTransactionTargets = (
  identityMaps: IdentityMapRegistry,
  pending: Transaction[]
): void => {
  for (const tx of pending) {
    const map = identityMaps.getMap<Record<string, unknown>>(tx.modelName);
    map.get(tx.modelId);
  }
};

/**
 * Re-applies pending outbox transactions to identity maps after a server sync.
 * This intentionally differs from rollbackTransaction (which inverts) and
 * applyDeltas (which writes to storage). It re-applies forward to restore
 * optimistic state on top of newly-synced server data.
 */
export const applyPendingTransactionsToIdentityMaps = (
  identityMaps: IdentityMapRegistry,
  pending: Transaction[]
): void => {
  if (pending.length === 0) {
    return;
  }

  for (const tx of pending) {
    const map = identityMaps.getMap<Record<string, unknown>>(tx.modelName);

    switch (tx.action) {
      case "I": {
        // Only re-create if the model was removed (e.g. conflict rollback).
        // If it already exists, the optimistic insert is still valid and
        // re-merging the full create payload would overwrite field changes
        // from optimistic updates whose outbox writes are still in-flight.
        if (!map.has(tx.modelId)) {
          map.merge(tx.modelId, tx.payload);
        }
        break;
      }
      case "U": {
        if (map.has(tx.modelId)) {
          map.merge(tx.modelId, tx.payload);
        }
        break;
      }
      case "D": {
        map.delete(tx.modelId);
        break;
      }
      case "A": {
        if (map.has(tx.modelId)) {
          map.merge(
            tx.modelId,
            createArchivePayload(readArchivedAt(tx.payload))
          );
        }
        break;
      }
      case "V": {
        const existing = map.get(tx.modelId);
        if (existing) {
          const updated = {
            ...existing,
            ...createUnarchivePatch(),
          };
          map.set(tx.modelId, updated);
        }
        break;
      }
      default: {
        break;
      }
    }
  }
};

/** Compares two group lists as sets (order-insensitive, dedupe-aware). */
export const areGroupsEqual = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  const setA = new Set(a);
  if (setA.size !== b.length) {
    return false;
  }
  for (const value of b) {
    if (!setA.has(value)) {
      return false;
    }
  }
  return true;
};
