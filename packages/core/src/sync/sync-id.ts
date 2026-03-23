/**
 * Sync ID type: string on the wire, represents a monotonically increasing integer.
 * Using string avoids precision loss for values exceeding Number.MAX_SAFE_INTEGER.
 */
export type SyncId = string;

/** Zero sync ID constant */
export const ZERO_SYNC_ID: SyncId = "0";

const LEADING_ZEROS = /^0+/;

/**
 * Compares two string-encoded sync IDs numerically.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
export const compareSyncId = (a: SyncId, b: SyncId): number => {
  const aStripped = a.replace(LEADING_ZEROS, "") || "0";
  const bStripped = b.replace(LEADING_ZEROS, "") || "0";

  if (aStripped.length !== bStripped.length) {
    return aStripped.length - bStripped.length;
  }
  if (aStripped < bStripped) {
    return -1;
  }
  if (aStripped > bStripped) {
    return 1;
  }
  return 0;
};

/** Returns the larger of two sync IDs */
export const maxSyncId = (a: SyncId, b: SyncId): SyncId =>
  compareSyncId(a, b) >= 0 ? a : b;

/** Checks if sync ID a is greater than sync ID b */
export const isSyncIdGreaterThan = (a: SyncId, b: SyncId): boolean =>
  compareSyncId(a, b) > 0;
