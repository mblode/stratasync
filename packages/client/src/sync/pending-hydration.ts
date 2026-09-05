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
        // Merge in place (mirroring the "A" branch) so class-model instance
        // identity and prototype getters survive. Spreading + set() would
        // shed the prototype and corrupt class-model instances.
        if (map.has(tx.modelId)) {
          map.merge(tx.modelId, createUnarchivePatch());
        }
        break;
      }
      default: {
        break;
      }
    }
  }
};

/**
 * Removes rollback data for mutations whose target is absent from a freshly
 * replaced server snapshot. The replacement is the authority for records that
 * previously existed: if a queued update/delete is later rejected, restoring
 * its pre-mutation value would recreate a row the caller can no longer read.
 *
 * Missing inserts remain durable but are withheld too: without model-specific
 * parent metadata, the client cannot prove that an offline child insert still
 * belongs to an authorized group. The server response and authorized delta
 * decide whether it can return to the identity map.
 */
export const preparePendingTransactionsForPrivacySnapshot = (
  identityMaps: IdentityMapRegistry,
  pending: Transaction[]
): {
  changed: Transaction[];
  replayable: Transaction[];
  withheld: Transaction[];
} => {
  const changed: Transaction[] = [];
  const replayable: Transaction[] = [];
  const withheld: Transaction[] = [];

  for (const tx of pending) {
    const map = identityMaps.getMap<Record<string, unknown>>(tx.modelName);
    if (map.has(tx.modelId)) {
      replayable.push(tx);
      continue;
    }
    withheld.push(tx);

    // An absent insert may belong below a parent group that was just revoked.
    // Generic model metadata cannot prove that relationship, so retain it in
    // the durable outbox but keep it (and later mutations to the same absent
    // target) out of the identity map until the server accepts it.
    if (tx.action !== "I" && tx.original !== undefined) {
      tx.original = undefined;
      changed.push(tx);
    }
  }

  return { changed, replayable, withheld };
};

export const excludePrivacyWithheldTransactions = (
  pending: Transaction[],
  withheldClientTxIds: string[] | undefined,
  identityMaps?: IdentityMapRegistry
): Transaction[] => {
  if (!withheldClientTxIds || withheldClientTxIds.length === 0) {
    return pending;
  }
  const withheld = new Set(withheldClientTxIds);
  return pending.filter(
    (tx) =>
      !withheld.has(tx.clientTxId) ||
      identityMaps?.getMap(tx.modelName).has(tx.modelId) === true
  );
};

/** Compares two group lists as sets (order-insensitive, duplicates ignored). */
export const areGroupsEqual = (a: string[], b: string[]): boolean => {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) {
    return false;
  }
  for (const value of setB) {
    if (!setA.has(value)) {
      return false;
    }
  }
  return true;
};
