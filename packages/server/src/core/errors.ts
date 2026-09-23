/**
 * Error code returned to clients whose sync cursor has fallen behind the
 * earliest retained sync action and must re-bootstrap.
 */
export const BOOTSTRAP_REQUIRED = "BOOTSTRAP_REQUIRED";

/**
 * The two channel-specific BOOTSTRAP_REQUIRED message strings. They differ on
 * the wire and MUST stay different: HTTP clients are fetching deltas, WS
 * clients are subscribing to deltas.
 */
export const BOOTSTRAP_REQUIRED_HTTP_MESSAGE =
  "A fresh bootstrap is required before fetching deltas";

export const BOOTSTRAP_REQUIRED_WS_MESSAGE =
  "A fresh bootstrap is required before subscribing to deltas";

/**
 * Whether a client that has applied everything up to `afterSyncId` can still
 * be caught up from `sync_actions`, whose catch-up floor is `earliestSyncId`:
 * the lowest retained id, or — once retention has emptied the table — one
 * above the highest id ever allocated (`SyncDao.getEarliestSyncId`). It is 0
 * only when no id was ever allocated, and then nothing can have been missed.
 *
 * The client is stale only when an action it has not seen may already have
 * been pruned: everything strictly between `afterSyncId` and `earliestSyncId`.
 * A cursor sitting exactly one below the earliest retained id therefore is
 * not stale — the next action it needs is the earliest one kept — which is
 * the boundary a `<` comparison used to force a needless full bootstrap on.
 */
export const isSyncCursorStale = (
  afterSyncId: bigint,
  earliestSyncId: bigint
): boolean =>
  afterSyncId > 0n && earliestSyncId > 0n && afterSyncId + 1n < earliestSyncId;
