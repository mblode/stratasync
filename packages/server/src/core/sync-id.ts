const NON_NEGATIVE_INTEGER_REGEX = /^\d+$/;

/**
 * Sync IDs are bigints internally and non-negative-integer strings on the wire.
 *
 * `SyncId` centralizes the parse/serialize/compare logic that was previously
 * scattered across the server. The wire serialization is byte-identical to the
 * historical `bigint.toString()` behavior.
 */
export const SyncId = {
  /**
   * Compares two bigint sync IDs (-1 | 0 | 1).
   */
  compare(left: bigint, right: bigint): number {
    if (left === right) {
      return 0;
    }
    return left < right ? -1 : 1;
  },

  /**
   * Returns true when `left` is strictly greater than `right`.
   */
  isAfter(left: bigint, right: bigint): boolean {
    return left > right;
  },

  /**
   * Parses a wire string into a bigint, rejecting non-numeric input.
   */
  parse(value: string): bigint {
    if (!NON_NEGATIVE_INTEGER_REGEX.test(value)) {
      throw new Error(`Invalid syncId: ${value}`);
    }
    return BigInt(value);
  },

  /**
   * Serializes a bigint sync ID to its wire string form.
   */
  serialize(value: bigint): string {
    return value.toString();
  },
} as const;

// Re-exported aliases. donebear imports SyncActionOutput.syncId as a string, so
// these string<->bigint helpers must keep their existing names and behavior.
export const serializeSyncId = (syncId: bigint): string =>
  SyncId.serialize(syncId);

export const parseSyncIdString = (syncId: string): bigint =>
  SyncId.parse(syncId);
