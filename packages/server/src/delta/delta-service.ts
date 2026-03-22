import type { SyncLogger } from "../config.js";
import { noopLogger } from "../config.js";
import type { SyncDao } from "../dao/sync-dao.js";
import type { DeltaPacket, SyncUserContext } from "../types.js";
import { serializeSyncId, toSyncActionOutput } from "../utils/sync-utils.js";

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
    const lastSyncId = lastAction
      ? (lastAction as { id: bigint }).id
      : afterSyncId;

    const outputActions = resultActions.map((action) =>
      toSyncActionOutput(
        action as {
          id: bigint;
          model: string;
          modelId: string;
          action: string;
          data: unknown;
          groupId: string | null;
          clientTxId: string | null;
          clientId: string | null;
          createdAt: Date;
        }
      )
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
