import type { SyncId } from "@stratasync/core";
import { isSyncIdGreaterThan, ZERO_SYNC_ID } from "@stratasync/core";

import type { StorageAdapter } from "../types.js";

/**
 * Owns the sync cursor: the last applied sync id (`lastSyncId`) and the floor
 * of the current bootstrap window (`firstSyncId`).
 *
 * `advance()` enforces the monotonic guard — the cursor only moves forward —
 * and persists the new value. Returns whether it actually advanced so callers
 * can gate `syncComplete` emission on real progress.
 */
export class SyncCursor {
  private _lastSyncId: SyncId = ZERO_SYNC_ID;
  private _firstSyncId: SyncId = ZERO_SYNC_ID;
  private readonly storage: StorageAdapter;

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  get lastSyncId(): SyncId {
    return this._lastSyncId;
  }

  get firstSyncId(): SyncId {
    return this._firstSyncId;
  }

  /** Loads cursor positions from persisted metadata. */
  hydrate(meta: { lastSyncId?: SyncId; firstSyncId?: SyncId }): void {
    this._lastSyncId = meta.lastSyncId ?? ZERO_SYNC_ID;
    this._firstSyncId = meta.firstSyncId ?? this._lastSyncId;
  }

  /** Resets both cursor positions to zero. */
  reset(): void {
    this._lastSyncId = ZERO_SYNC_ID;
    this._firstSyncId = ZERO_SYNC_ID;
  }

  /**
   * Sets `firstSyncId` to the current `lastSyncId` without persisting. Callers
   * persist alongside their own metadata (e.g. subscribed groups).
   */
  resetFirstToLast(): void {
    this._firstSyncId = this._lastSyncId;
  }

  /** Sets `firstSyncId` directly (does not persist). */
  setFirstSyncId(syncId: SyncId): void {
    this._firstSyncId = syncId;
  }

  /**
   * Sets both cursor positions to the bootstrap snapshot's sync id without the
   * monotonic guard (bootstrap is authoritative). Does not persist; the caller
   * persists the full bootstrap metadata.
   */
  setFromBootstrap(syncId: SyncId): void {
    this._lastSyncId = syncId;
    this._firstSyncId = syncId;
  }

  /**
   * Advances `lastSyncId` if `syncId` is strictly greater, persisting the new
   * value. Returns true when the cursor moved forward.
   */
  async advance(syncId: SyncId): Promise<boolean> {
    if (!isSyncIdGreaterThan(syncId, this._lastSyncId)) {
      return false;
    }
    this._lastSyncId = syncId;
    await this.storage.setMeta({
      lastSyncAt: Date.now(),
      lastSyncId: this._lastSyncId,
      updatedAt: Date.now(),
    });
    return true;
  }
}
