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
import { SyncDao } from "./dao/sync-dao.js";
import type {
  DeltaPublisherLike,
  DeltaSubscriberLike,
} from "./delta/delta-publisher.js";
import {
  createCompositeDeltaPublisher,
  createDeltaPublisher,
  createDeltaSubscriber,
  createInMemoryDeltaBus,
  createInMemoryDeltaPublisher,
  createInMemoryDeltaSubscriber,
} from "./delta/delta-publisher.js";
import { DeltaService } from "./delta/delta-service.js";
import { createSyncAuthMiddleware } from "./fastify/middleware.js";
import { registerSyncRoutes } from "./fastify/routes.js";
import { MutateService } from "./mutate/mutate-service.js";
import { registerSyncWebsocket } from "./websocket/sync-websocket.js";

interface SyncModuleState {
  deltaPublisher: DeltaPublisherLike | null;
  deltaSubscriber: DeltaSubscriberLike | null;
  redisSubscriber: DeltaSubscriberLike | null;
}

export const createSyncServer = async (
  config: SyncServerConfig & { websocketHooks?: WebSocketHooks }
): Promise<SyncServer> => {
  const logger: SyncLogger = config.logger ?? noopLogger;

  // Create DAO
  const syncDao = new SyncDao(config.db, config.tables);

  // Set up delta publisher chain
  const localBus = createInMemoryDeltaBus();
  const localPublisher = createInMemoryDeltaPublisher(localBus);
  const localSubscriber = createInMemoryDeltaSubscriber(localBus);

  const state: SyncModuleState = {
    deltaPublisher: null,
    deltaSubscriber: localSubscriber,
    redisSubscriber: null,
  };

  const publishers: DeltaPublisherLike[] = [localPublisher];

  if (config.redis) {
    const serverId = `sync-${randomUUID().slice(0, 8)}`;
    const redisPublisher = createDeltaPublisher(config.redis, serverId);
    const redisSubscriber = createDeltaSubscriber(config.redis, serverId);

    await redisSubscriber.start();
    state.redisSubscriber = redisSubscriber;

    redisSubscriber.onDelta(async (action, groups) => {
      try {
        await localPublisher.publish(action, groups);
      } catch (error) {
        const formattedError =
          error instanceof Error ? error : new Error(String(error));
        logger.error({ err: formattedError }, "Failed to relay delta");
      }
    });

    publishers.push(redisPublisher);
    logger.debug({ serverId }, "Sync delta subscriber started");
  } else {
    logger.debug({}, "Sync delta bus running in-memory (no Redis)");
  }

  const deltaPublisher = createCompositeDeltaPublisher(publishers, logger);
  state.deltaPublisher = deltaPublisher;

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
      deltaSubscriber: localSubscriber,
      hooks: config.websocketHooks,
      logger,
      syncDao,
    });

    logger.debug(
      {},
      "Sync module initialized: /sync/bootstrap, /sync/batch, /sync/deltas, /sync/mutate, /sync/ws"
    );
  };

  // Shutdown
  const shutdown = async (): Promise<void> => {
    if (state.redisSubscriber) {
      await state.redisSubscriber.stop();
      state.redisSubscriber = null;
    }
    if (state.deltaSubscriber) {
      await state.deltaSubscriber.stop();
      state.deltaSubscriber = null;
    }
    state.deltaPublisher = null;
  };

  return {
    bootstrapService,
    deltaPublisher,
    deltaService,
    deltaSubscriber: localSubscriber,
    mutateService,
    registerRoutes,
    shutdown,
    syncDao,
  };
};
