import { Readable } from "node:stream";

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteHandlerMethod,
} from "fastify";

import type { BootstrapService } from "../bootstrap/bootstrap-service.js";
import type { SyncLogger } from "../config.js";
import { noopLogger } from "../config.js";
import {
  BOOTSTRAP_REQUIRED,
  BOOTSTRAP_REQUIRED_HTTP_MESSAGE,
} from "../core/errors.js";
import { parseSyncIdString } from "../core/sync-id.js";
import type { DeltaPublisherLike } from "../delta/delta-publisher.js";
import type { DeltaService } from "../delta/delta-service.js";
import { MutateService } from "../mutate/mutate-service.js";
import type { MutateInput } from "../types.js";
import {
  resolvePublishedDeltaGroups,
  resolveRequestedSyncGroups,
} from "../utils/sync-scope.js";
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

const splitList = (value: string | undefined): string[] | undefined =>
  value?.split(",").filter(Boolean);

const withNdjsonErrors = async function* withNdjsonErrors(
  lines: AsyncIterable<string>
): AsyncGenerator<string> {
  try {
    for await (const line of lines) {
      yield `${line}\n`;
    }
  } catch (error) {
    yield `${JSON.stringify({
      message: error instanceof Error ? error.message : "Unknown error",
      type: "error",
    })}\n`;
  }
};

const sendNdjson = (
  reply: FastifyReply,
  lines: AsyncIterable<string>
): FastifyReply => {
  reply.header("Cache-Control", "no-store");
  reply.type("application/x-ndjson");
  return reply.send(
    Readable.from(withNdjsonErrors(lines), { encoding: "utf8" })
  );
};

/** Creates the native Fastify bootstrap stream handler for custom route wiring. */
export const createBootstrapRouteHandler =
  (
    bootstrapService: Pick<BootstrapService, "generateBootstrapNdjson">
  ): RouteHandlerMethod =>
  (request, reply) => {
    const syncUser = getSyncUser(request);
    const query = request.query as BootstrapQuery;
    const syncGroups = resolveRequestedSyncGroups(
      syncUser.groups,
      splitList(query.syncGroups)
    );

    return sendNdjson(
      reply,
      bootstrapService.generateBootstrapNdjson(syncUser, {
        firstSyncId: query.firstSyncId,
        groups: syncGroups,
        models: splitList(query.onlyModels),
        noSyncPackets: query.noSyncPackets === "true",
        schemaHash: query.schemaHash ?? "",
        type: query.type,
      })
    );
  };

/** Creates the native Fastify batch-load stream handler for custom route wiring. */
export const createBatchLoadRouteHandler =
  (
    bootstrapService: Pick<BootstrapService, "batchLoadNdjson">
  ): RouteHandlerMethod =>
  (request, reply) => {
    const syncUser = getSyncUser(request);
    const { firstSyncId, requests } = request.body as BatchLoadBody;
    return sendNdjson(
      reply,
      bootstrapService.batchLoadNdjson(syncUser, requests, firstSyncId)
    );
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
  writeAuthMiddleware?: (
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
    writeAuthMiddleware = authMiddleware,
  } = options;

  // GET /sync/bootstrap
  server.get<{ Querystring: BootstrapQuery }>(
    "/sync/bootstrap",
    { preHandler: [validateQuery(BootstrapQuerySchema), authMiddleware] },
    createBootstrapRouteHandler(bootstrapService)
  );

  // POST /sync/batch
  server.post<{ Body: BatchLoadBody }>(
    "/sync/batch",
    { preHandler: [validateBody(BatchLoadBodySchema), authMiddleware] },
    createBatchLoadRouteHandler(bootstrapService)
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

      if (await deltaService.isCursorStale(afterSyncId)) {
        return reply.code(409).send({
          error: BOOTSTRAP_REQUIRED,
          message: BOOTSTRAP_REQUIRED_HTTP_MESSAGE,
        });
      }

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
    { preHandler: [validateBody(MutateBodySchema), writeAuthMiddleware] },
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
        // The DAO's insert-order advisory lock guarantees IDs are allocated in
        // commit order, but this post-commit publish still races: two committed
        // actions can be handed to `onAction` out of order relative to their
        // IDs. Tolerated here — a fully ordered fix would require transactional
        // NOTIFY (publish inside the commit), which is out of scope.
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
