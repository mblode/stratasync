import type { WebSocket } from "ws";

import { isSyncCursorStale } from "../core/errors.js";
import { toSyncActionOutput } from "../core/sync-action.js";
import type { SyncDao } from "../dao/sync-dao.js";
import type { ClientSession } from "./client-session.js";

const REPLAY_PAGE_SIZE = 1000;

/**
 * Whether retention may have pruned actions above `afterSyncId` that a page
 * just read from it should have returned. Call it after the read, never only
 * before: retention deletes the oldest actions while reads run, and a page
 * read after a prune starts above the cutoff with nothing in it to show the
 * gap. Retention deletes a prefix of ids, so if the floor read after the page
 * is still at most `afterSyncId + 1`, nothing above the cursor was gone when
 * the page was read. One primary-key lookup; skipped for cursor 0, which
 * {@link isSyncCursorStale} never treats as stale.
 */
export const isPageBehindRetention = async (
  syncDao: SyncDao,
  afterSyncId: bigint
): Promise<boolean> =>
  afterSyncId > 0n &&
  isSyncCursorStale(afterSyncId, await syncDao.getEarliestSyncId());

export type ReplayOutcome = "done" | "bootstrap-required";

/**
 * Pages through persisted sync actions after the session cursor and delivers
 * each via the session. Stops when the socket closes, the session closes, or a
 * short (partial) page is returned. Returns `"bootstrap-required"`, before
 * delivering the page, when retention pruned actions the page needed.
 */
export const replaySyncActions = async (
  syncDao: SyncDao,
  socket: WebSocket,
  session: ClientSession
): Promise<ReplayOutcome> => {
  let replayCursor = session.afterSyncId;

  while (true) {
    if (session.isClosed || socket.readyState !== socket.OPEN) {
      return "done";
    }

    const actions = await syncDao.getSyncActions(
      replayCursor,
      session.groups,
      REPLAY_PAGE_SIZE
    );
    if (await isPageBehindRetention(syncDao, replayCursor)) {
      return "bootstrap-required";
    }
    if (actions.length === 0) {
      break;
    }

    for (const action of actions) {
      // Replay pages read `sync_actions` contiguously from the cursor, so
      // there is no gap below any row to fill.
      await session.sendDeltaAction(toSyncActionOutput(action), {
        scanned: true,
      });
      if (session.isClosed) {
        return "done";
      }
    }

    const lastAction = actions.at(-1);
    if (!lastAction || actions.length < REPLAY_PAGE_SIZE) {
      break;
    }

    replayCursor = lastAction.id;
  }
  return "done";
};
