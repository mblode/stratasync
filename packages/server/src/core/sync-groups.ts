/**
 * Sync-group change actions.
 *
 * A membership change reaches a client as an ordinary sync action rather than
 * an out-of-band frame. That choice is deliberate: an action carries a syncId
 * and lives in `sync_actions`, so it is delivered by bootstrap, replay,
 * catch-up and the live stream alike. A frame is only delivered to a socket
 * that happens to be open, and a client that missed one would keep serving
 * cached rows from a group it no longer belongs to.
 *
 * The action is addressed to the changed user's own group (their userId), which
 * `authorizeToken` always includes, so exactly that user receives it.
 */

/**
 * Action code for a group-membership change. Deliberately outside the
 * `ModelAction` union: it mutates no model, and clients route it by this code
 * rather than applying it as a row.
 */
export const SYNC_GROUPS_ACTION = "G";

/**
 * Synthetic model name carried by a group-change action. No client registers a
 * model under this name, so the row-applying path skips it (it filters on the
 * schema registry) while the group handler still sees it.
 */
export const SYNC_GROUPS_MODEL = "__sync_groups__";

/** Payload shape of a group-change action's `data`. */
export interface SyncGroupsChangeData {
  subscribedSyncGroups: string[];
}
