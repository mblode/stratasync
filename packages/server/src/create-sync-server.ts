import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { BootstrapService } from "./bootstrap/bootstrap-service.js";
import type {
  SyncLogger,
  SyncServer,
  SyncServerConfig,
  WebSocketHooks,
} from "./config.js";
import { noopLogger } from "./config.js";
import { toSyncActionOutput } from "./core/sync-action.js";
import { SYNC_GROUPS_ACTION, SYNC_GROUPS_MODEL } from "./core/sync-groups.js";
import { SyncDao } from "./dao/sync-dao.js";
import type {
  DeltaPublisherLike,
  RedisDeltaTransport,
} from "./delta/delta-publisher.js";
import {
  createDeltaBus,
  createDeltaPublisher,
  createRedisDeltaTransport,
} from "./delta/delta-publisher.js";
import { DeltaService } from "./delta/delta-service.js";
import { createSyncAuthMiddleware } from "./fastify/middleware.js";
import { registerSyncRoutes } from "./fastify/routes.js";
import { MutateService } from "./mutate/mutate-service.js";
import { dedupeSyncGroups } from "./utils/sync-scope.js";
import { registerSyncWebsocket } from "./websocket/sync-websocket.js";

export const createSyncServer = async (
  config: SyncServerConfig & { websocketHooks?: WebSocketHooks }
): Promise<SyncServer> => {
  const logger: SyncLogger = config.logger ?? noopLogger;

  // Create DAO
  const syncDao = new SyncDao(config.db, config.tables);

  // The in-process bus is the local subscriber the WebSocket listens on and the
  // local-first publish target. Redis (if present) fans deltas across processes
  // and relays inbound deltas back into the same bus.
  const bus = createDeltaBus(logger);

  let redisTransport: RedisDeltaTransport | undefined;
  if (config.redis) {
    const serverId = `sync-${randomUUID().slice(0, 8)}`;
    redisTransport = createRedisDeltaTransport(
      config.redis,
      bus,
      serverId,
      logger
    );
    await redisTransport.start();
    logger.debug({ serverId }, "Sync delta subscriber started");
  } else {
    logger.debug({}, "Sync delta bus running in-memory (no Redis)");
  }

  const deltaPublisher: DeltaPublisherLike = createDeltaPublisher(
    bus,
    redisTransport,
    logger
  );

  // Create services
  const bootstrapService = new BootstrapService(
    config.db,
    syncDao,
    config.models,
    logger
  );

  const deltaService = new DeltaService(syncDao, logger);

  const mutateService = new MutateService(
    config.db,
    syncDao,
    config.models,
    logger
  );

  // Route registration
  const registerRoutes = (server: unknown): void => {
    const fastifyServer = server as FastifyInstance;

    const authMiddleware = createSyncAuthMiddleware(
      config.auth,
      syncDao,
      logger
    );

    registerSyncRoutes(fastifyServer, {
      authMiddleware,
      bootstrapService,
      deltaPublisher,
      deltaService,
      logger,
      mutateService,
    });

    registerSyncWebsocket(fastifyServer, {
      auth: config.auth,
      deltaSubscriber: bus,
      hooks: config.websocketHooks,
      logger,
      syncDao,
    });

    logger.debug(
      {},
      "Sync module initialized: /sync/bootstrap, /sync/batch, /sync/deltas, /sync/mutate, /sync/ws"
    );
  };

  /**
   * Emits a durable group-membership change for one user.
   *
   * This is an ordinary sync action rather than an out-of-band frame, which is
   * what makes it survive the user being offline: it carries a syncId, so a
   * client that misses the live publish still receives it on its next replay or
   * catch-up. An out-of-band frame would simply be dropped, leaving that
   * client's cache serving rows from a group it no longer belongs to until
   * something forced a full bootstrap.
   *
   * The action is addressed to the user's own group, which `authorizeToken`
   * always includes, so exactly that user receives it.
   */
  const notifyGroupsChanged = async (userId: string): Promise<void> => {
    const [resolvedGroups, dbGroups] = await Promise.all([
      config.auth.resolveGroups(userId),
      syncDao.getUserGroups(userId),
    ]);
    const groups = dedupeSyncGroups([...resolvedGroups, ...dbGroups, userId]);

    const action = await syncDao.createSyncAction({
      action: SYNC_GROUPS_ACTION,
      clientId: null,
      clientTxId: null,
      data: { subscribedSyncGroups: groups },
      groupId: userId,
      model: SYNC_GROUPS_MODEL,
      modelId: userId,
    });

    await deltaPublisher.publish(toSyncActionOutput(action), [userId]);

    logger.debug(
      { groupCount: groups.length, userId },
      "Published sync group change"
    );
  };

  // Shutdown
  const shutdown = async (): Promise<void> => {
    if (redisTransport) {
      await redisTransport.stop();
      redisTransport = undefined;
    }
    await bus.stop();
  };

  return {
    bootstrapService,
    deltaPublisher,
    deltaService,
    deltaSubscriber: bus,
    mutateService,
    notifyGroupsChanged,
    registerRoutes,
    shutdown,
    syncDao,
  };
};
