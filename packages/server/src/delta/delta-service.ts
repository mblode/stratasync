import type { SyncLogger } from "../config.js";
import { noopLogger } from "../config.js";
import { toSyncActionOutput } from "../core/sync-action.js";
import { serializeSyncId } from "../core/sync-id.js";
import type { SyncDao } from "../dao/sync-dao.js";
import type { DeltaPacket, SyncUserContext } from "../types.js";

/**
 * Service for fetching sync deltas.
 */
export class DeltaService {
  private readonly dao: SyncDao;
  private readonly logger: SyncLogger;

  constructor(dao: SyncDao, logger: SyncLogger = noopLogger) {
    this.dao = dao;
    this.logger = logger;
  }

  async isCursorStale(afterSyncId: bigint): Promise<boolean> {
    if (afterSyncId <= 0n) {
      return false;
    }

    const earliestSyncId = await this.dao.getEarliestSyncId();
    return earliestSyncId > 0n && afterSyncId < earliestSyncId;
  }

  async fetchDeltas(
    context: SyncUserContext,
    afterSyncId: bigint,
    limit: number
  ): Promise<DeltaPacket> {
    this.logger.debug(
      { afterSyncId: String(afterSyncId), limit, userId: context.userId },
      "Fetching deltas"
    );

    const actions = await this.dao.getSyncActions(
      afterSyncId,
      context.groups,
      limit + 1
    );

    const hasMore = actions.length > limit;
    const resultActions = hasMore ? actions.slice(0, limit) : actions;

    const lastAction = resultActions.at(-1);
    const lastSyncId = lastAction ? lastAction.id : afterSyncId;

    const outputActions = resultActions.map((action) =>
      toSyncActionOutput(action)
    );

    this.logger.debug(
      {
        actionsCount: outputActions.length,
        hasMore,
        lastSyncId: serializeSyncId(lastSyncId),
        userId: context.userId,
      },
      "Deltas fetched"
    );

    return {
      actions: outputActions,
      hasMore,
      lastSyncId: serializeSyncId(lastSyncId),
    };
  }
}
