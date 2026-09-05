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
import type { SyncDb } from "./db.js";
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
    const writeAuthMiddleware = createSyncAuthMiddleware(
      config.auth,
      syncDao,
      logger,
      "write"
    );

    registerSyncRoutes(fastifyServer, {
      authMiddleware,
      bootstrapService,
      deltaPublisher,
      deltaService,
      logger,
      mutateService,
      writeAuthMiddleware,
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
   * The action is addressed to the user's own group. Credential policies that
   * need live refreshes must include that group in their allowed set; delivery
   * rewrites the payload to the connection's final authorized groups.
   */
  const notifyGroupsChanged = async (userId: string): Promise<void> => {
    const [resolvedGroups, dbGroups] = await Promise.all([
      config.auth.resolveGroups(userId),
      syncDao.getUserGroups(userId),
    ]);
    const groups = dedupeSyncGroups([...resolvedGroups, ...dbGroups, userId]);

    // Must run in a transaction. createSyncAction takes a
    // `pg_advisory_xact_lock` to allocate ids in commit order; that lock is
    // transaction-scoped, so calling it on the pool would release it in its own
    // implicit transaction and leave the insert unprotected. A concurrent
    // mutate could then make a higher id visible first and a keyset reader
    // (`gt(id, cursor)`) would skip this action for good — losing exactly the
    // membership change this exists to deliver.
    const action = await (config.db as SyncDb).transaction(
      async (txDb) =>
        await syncDao.withDb(txDb).createSyncAction({
          action: SYNC_GROUPS_ACTION,
          clientId: null,
          clientTxId: null,
          data: { subscribedSyncGroups: groups },
          groupId: userId,
          model: SYNC_GROUPS_MODEL,
          modelId: userId,
        })
    );

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
