import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { BootstrapService } from "../bootstrap/bootstrap-service.js";
import type { SyncLogger } from "../config.js";
import { noopLogger } from "../config.js";
import type { DeltaPublisherLike } from "../delta/delta-publisher.js";
import type { DeltaService } from "../delta/delta-service.js";
import { MutateService } from "../mutate/mutate-service.js";
import type { MutateInput } from "../types.js";
import {
  resolvePublishedDeltaGroups,
  resolveRequestedSyncGroups,
} from "../utils/sync-scope.js";
import { parseSyncIdString } from "../utils/sync-utils.js";
import { getSyncUser, validateBody, validateQuery } from "./middleware.js";
import type {
  BatchLoadBody,
  BootstrapQuery,
  DeltaQuery,
  MutateBody,
} from "./validation.js";
import {
  BatchLoadBodySchema,
  BootstrapQuerySchema,
  DeltaQuerySchema,
  MutateBodySchema,
} from "./validation.js";

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

const setNdjsonStreamHeaders = (reply: FastifyReply): void => {
  // Copy plugin-set headers (e.g. CORS) to the raw response before streaming
  const pluginHeaders = reply.getHeaders();
  for (const [key, value] of Object.entries(pluginHeaders)) {
    if (value !== undefined) {
      reply.raw.setHeader(key, value as number | string | string[]);
    }
  }

  reply.raw.statusCode = 200;
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("Content-Type", "application/x-ndjson");
  reply.raw.setHeader("Transfer-Encoding", "chunked");
  reply.hijack();
};

interface RegisterRoutesOptions {
  bootstrapService: BootstrapService;
  deltaService: DeltaService;
  mutateService: MutateService;
  deltaPublisher?: DeltaPublisherLike;
  authMiddleware: (
    request: FastifyRequest,
    reply: FastifyReply
  ) => Promise<void>;
  logger?: SyncLogger;
}

export const registerSyncRoutes = (
  server: FastifyInstance,
  options: RegisterRoutesOptions
): void => {
  const {
    authMiddleware,
    bootstrapService,
    deltaPublisher,
    deltaService,
    logger = noopLogger,
    mutateService,
  } = options;

  // GET /sync/bootstrap
  server.get<{ Querystring: BootstrapQuery }>(
    "/sync/bootstrap",
    { preHandler: [validateQuery(BootstrapQuerySchema), authMiddleware] },
    async (
      request: FastifyRequest<{ Querystring: BootstrapQuery }>,
      reply: FastifyReply
    ) => {
      const syncUser = getSyncUser(request);
      const { query } = request;

      const onlyModels = query.onlyModels?.split(",").filter(Boolean);
      const requestedGroups = query.syncGroups?.split(",").filter(Boolean);
      const syncGroups = resolveRequestedSyncGroups(
        syncUser.groups,
        requestedGroups
      );
      const { schemaHash } = query;

      setNdjsonStreamHeaders(reply);

      try {
        for await (const line of bootstrapService.generateBootstrapNdjson(
          syncUser,
          {
            groups: syncGroups,
            models: onlyModels,
            schemaHash: schemaHash ?? "",
          }
        )) {
          reply.raw.write(`${line}\n`);
        }
      } catch (error) {
        reply.raw.write(
          `${JSON.stringify({
            message: error instanceof Error ? error.message : "Unknown error",
            type: "error",
          })}\n`
        );
      }

      reply.raw.end();
    }
  );

  // POST /sync/batch
  server.post<{ Body: BatchLoadBody }>(
    "/sync/batch",
    { preHandler: [validateBody(BatchLoadBodySchema), authMiddleware] },
    async (
      request: FastifyRequest<{ Body: BatchLoadBody }>,
      reply: FastifyReply
    ) => {
      const syncUser = getSyncUser(request);
      const { firstSyncId, requests } = request.body;

      setNdjsonStreamHeaders(reply);

      try {
        for await (const line of bootstrapService.batchLoadNdjson(
          syncUser,
          requests,
          firstSyncId
        )) {
          reply.raw.write(`${line}\n`);
        }
      } catch (error) {
        reply.raw.write(
          `${JSON.stringify({
            message: error instanceof Error ? error.message : "Unknown error",
            type: "error",
          })}\n`
        );
      }

      reply.raw.end();
    }
  );

  // GET /sync/deltas
  server.get<{ Querystring: DeltaQuery }>(
    "/sync/deltas",
    { preHandler: [validateQuery(DeltaQuerySchema), authMiddleware] },
    async (
      request: FastifyRequest<{ Querystring: DeltaQuery }>,
      reply: FastifyReply
    ) => {
      const syncUser = getSyncUser(request);
      const syncGroups = resolveRequestedSyncGroups(
        syncUser.groups,
        request.query.syncGroups?.split(",").filter(Boolean)
      );

      const afterSyncId = request.query.after
        ? parseSyncIdString(request.query.after)
        : 0n;

      let limit = request.query.limit
        ? Number.parseInt(request.query.limit, 10)
        : DEFAULT_LIMIT;

      if (Number.isNaN(limit) || limit < 1) {
        limit = DEFAULT_LIMIT;
      } else if (limit > MAX_LIMIT) {
        limit = MAX_LIMIT;
      }

      const packet = await deltaService.fetchDeltas(
        {
          ...syncUser,
          groups: syncGroups,
        },
        afterSyncId,
        limit
      );

      return reply.send({
        actions: packet.actions.map((action) => ({
          action: action.action,
          clientId: action.clientId,
          clientTxId: action.clientTxId,
          createdAt: action.createdAt.toISOString(),
          data: action.data,
          groupId: action.groupId,
          modelId: action.modelId,
          modelName: action.modelName,
          syncId: action.syncId,
        })),
        hasMore: packet.hasMore,
        lastSyncId: packet.lastSyncId,
      });
    }
  );

  // POST /sync/mutate
  server.post<{ Body: MutateBody }>(
    "/sync/mutate",
    { preHandler: [validateBody(MutateBodySchema), authMiddleware] },
    async (
      request: FastifyRequest<{ Body: MutateBody }>,
      reply: FastifyReply
    ) => {
      const syncUser = getSyncUser(request);
      const { batchId, transactions } = request.body;

      const transactionSummaries = transactions.map((tx) => ({
        action: tx.action,
        clientId: tx.clientId,
        clientTxId: tx.clientTxId,
        modelId: tx.modelId,
        modelName: tx.modelName,
        payloadKeys: Object.keys(tx.payload ?? {}),
      }));

      logger.debug(
        {
          batchId,
          transactionCount: transactions.length,
          transactions: transactionSummaries,
        },
        "Sync mutate request received"
      );

      for (const tx of transactions) {
        const errors = MutateService.validateTransaction(tx);
        if (errors.length > 0) {
          return reply.code(400).send({
            clientTxId: tx.clientTxId,
            details: errors,
            error: "Invalid transaction",
          });
        }
      }

      const input: MutateInput = { batchId, transactions };

      const result = await mutateService.mutate(syncUser, input, (action) => {
        if (deltaPublisher) {
          const groups = resolvePublishedDeltaGroups(
            action.groupId,
            syncUser.groups
          );
          deltaPublisher.publish(action, groups).catch((error) => {
            const formattedError =
              error instanceof Error ? error : new Error(String(error));
            logger.error({ err: formattedError }, "Failed to publish delta");
          });
        }
      });

      return reply.send({
        lastSyncId: result.lastSyncId,
        results: result.results,
        success: result.success,
      });
    }
  );
};
