import type { WebSocket } from "ws";

import { toSyncActionOutput } from "../core/sync-action.js";
import type { SyncDao } from "../dao/sync-dao.js";
import type { ClientSession } from "./client-session.js";

const REPLAY_PAGE_SIZE = 1000;

/**
 * Pages through persisted sync actions after the session cursor and delivers
 * each via the session. Stops when the socket closes, the session closes, or a
 * short (partial) page is returned.
 */
export const replaySyncActions = async (
  syncDao: SyncDao,
  socket: WebSocket,
  session: ClientSession
): Promise<void> => {
  let replayCursor = session.afterSyncId;

  while (true) {
    if (session.isClosed || socket.readyState !== socket.OPEN) {
      return;
    }

    const actions = await syncDao.getSyncActions(
      replayCursor,
      session.groups,
      REPLAY_PAGE_SIZE
    );
    if (actions.length === 0) {
      break;
    }

    for (const action of actions) {
      session.sendDeltaAction(toSyncActionOutput(action));
    }

    const lastAction = actions.at(-1);
    if (!lastAction || actions.length < REPLAY_PAGE_SIZE) {
      break;
    }

    replayCursor = lastAction.id;
  }
};
