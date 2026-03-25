import fastify from "fastify";

import type { BootstrapService } from "../../src/bootstrap/bootstrap-service.js";
import type { DeltaService } from "../../src/delta/delta-service.js";
import { registerSyncRoutes } from "../../src/fastify/routes.js";
import {
  BootstrapQuerySchema,
  BatchLoadBodySchema,
  MutateBodySchema,
} from "../../src/fastify/validation.js";
import type { MutateService } from "../../src/mutate/mutate-service.js";

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

const makeAuthMiddleware = () =>
  vi.fn((request: Record<string, unknown>) => {
    request.syncUser = {
      groups: ["workspace-1"],
      userId: "user-1",
    };
    return Promise.resolve();
  });

const makeBootstrapService = (
  lines: string[] = ['{"type":"metadata"}', '{"type":"row"}']
): BootstrapService =>
  ({
    async *batchLoadNdjson() {
      for (const line of lines) {
        yield line;
      }
    },
    async *generateBootstrapNdjson() {
      for (const line of lines) {
        yield line;
      }
    },
  }) as unknown as BootstrapService;

const makeDeltaService = (): DeltaService =>
  ({
    fetchDeltas() {
      return {
        actions: [],
        hasMore: false,
        lastSyncId: "0",
      };
    },
    isCursorStale() {
      return false;
    },
  }) as unknown as DeltaService;

const makeMutateService = (): MutateService =>
  ({
    mutate(_context, input) {
      return {
        lastSyncId: "42",
        results: input.transactions.map((tx) => ({
          clientTxId: tx.clientTxId,
          success: true,
          syncId: "42",
        })),
        success: true,
      };
    },
  }) as unknown as MutateService;

const createApp = (overrides?: {
  bootstrapService?: BootstrapService;
  deltaService?: DeltaService;
  mutateService?: MutateService;
}) => {
  const app = fastify();
  const authMiddleware = makeAuthMiddleware();

  registerSyncRoutes(app, {
    authMiddleware,
    bootstrapService: overrides?.bootstrapService ?? makeBootstrapService(),
    deltaService: overrides?.deltaService ?? makeDeltaService(),
    logger,
    mutateService: overrides?.mutateService ?? makeMutateService(),
  });

  return { app, authMiddleware };
};

describe(BatchLoadBodySchema, () => {
  it("rejects more than 100 batch requests", () => {
    const result = BatchLoadBodySchema.safeParse({
      requests: Array.from({ length: 101 }, () => ({
        groupId: "workspace-1",
        modelName: "Task",
      })),
    });

    expect(result.success).toBeFalsy();
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain(
        "At most 100 requests are allowed"
      );
    }
  });
});

describe(BootstrapQuerySchema, () => {
  it("requires firstSyncId for partial bootstrap", () => {
    const result = BootstrapQuerySchema.safeParse({
      type: "partial",
    });

    expect(result.success).toBeFalsy();
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain(
        "firstSyncId is required for partial bootstrap"
      );
    }
  });

  it("accepts validated partial bootstrap query params", () => {
    const result = BootstrapQuerySchema.safeParse({
      firstSyncId: "42",
      noSyncPackets: "true",
      onlyModels: "Task,Team",
      schemaHash: "schema-1",
      syncGroups: "workspace-1",
      type: "partial",
    });

    expect(result.success).toBeTruthy();
  });
});

describe(MutateBodySchema, () => {
  it("accepts a non-UUID modelId", () => {
    const result = MutateBodySchema.safeParse({
      batchId: "batch-1",
      transactions: [
        {
          action: "INSERT",
          clientId: "client-1",
          clientTxId: "tx-1",
          modelId: "task-1",
          modelName: "Task",
          payload: { title: "Hello" },
        },
      ],
    });

    expect(result.success).toBeTruthy();
  });

  it("rejects more than 100 transactions", () => {
    const result = MutateBodySchema.safeParse({
      batchId: "batch-1",
      transactions: Array.from({ length: 101 }, (_, index) => ({
        action: "INSERT",
        clientId: "client-1",
        clientTxId: `tx-${index}`,
        modelId: `task-${index}`,
        modelName: "Task",
        payload: { title: "Hello" },
      })),
    });

    expect(result.success).toBeFalsy();
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain(
        "At most 100 transactions are allowed"
      );
    }
  });
});

describe(registerSyncRoutes, () => {
  it("streams bootstrap and batch responses without echoing origin CORS headers", async () => {
    const { app } = createApp();
    try {
      await app.ready();

      const bootstrapResponse = await app.inject({
        headers: {
          authorization: "Bearer token",
          origin: "https://example.com",
        },
        method: "GET",
        url: "/sync/bootstrap?schemaHash=abc",
      });

      expect(bootstrapResponse.statusCode).toBe(200);
      expect(bootstrapResponse.body).toBe(
        '{"type":"metadata"}\n{"type":"row"}\n'
      );
      expect(bootstrapResponse.headers["cache-control"]).toBe("no-cache");
      expect(bootstrapResponse.headers.connection).toBe("keep-alive");
      expect(bootstrapResponse.headers["content-type"]).toContain(
        "application/x-ndjson"
      );
      expect(bootstrapResponse.headers["transfer-encoding"]).toBe("chunked");
      expect(
        bootstrapResponse.headers["access-control-allow-origin"]
      ).toBeUndefined();
      expect(
        bootstrapResponse.headers["access-control-allow-credentials"]
      ).toBeUndefined();

      const batchResponse = await app.inject({
        headers: {
          authorization: "Bearer token",
          origin: "https://example.com",
        },
        method: "POST",
        payload: {
          requests: [{ groupId: "workspace-1", modelName: "Task" }],
        },
        url: "/sync/batch",
      });

      expect(batchResponse.statusCode).toBe(200);
      expect(batchResponse.body).toBe('{"type":"metadata"}\n{"type":"row"}\n');
      expect(batchResponse.headers["cache-control"]).toBe("no-cache");
      expect(batchResponse.headers.connection).toBe("keep-alive");
      expect(batchResponse.headers["content-type"]).toContain(
        "application/x-ndjson"
      );
      expect(batchResponse.headers["transfer-encoding"]).toBe("chunked");
      expect(
        batchResponse.headers["access-control-allow-origin"]
      ).toBeUndefined();
      expect(
        batchResponse.headers["access-control-allow-credentials"]
      ).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("forwards partial bootstrap query params to the bootstrap service", async () => {
    const generateBootstrapNdjson = vi.fn(async function* streamBootstrap() {
      yield '{"type":"metadata"}';
      yield '{"type":"row"}';
    });
    const bootstrapService = {
      async *batchLoadNdjson() {
        yield* [];
      },
      generateBootstrapNdjson,
    } as unknown as BootstrapService;
    const { app } = createApp({ bootstrapService });

    try {
      await app.ready();

      const response = await app.inject({
        headers: {
          authorization: "Bearer token",
        },
        method: "GET",
        url: "/sync/bootstrap?type=partial&firstSyncId=42&syncGroups=workspace-1&onlyModels=Task,Team&noSyncPackets=true&schemaHash=abc",
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('{"type":"metadata"}\n{"type":"row"}\n');
      expect(generateBootstrapNdjson).toHaveBeenCalledOnce();
      expect(generateBootstrapNdjson).toHaveBeenCalledWith(
        {
          groups: ["workspace-1"],
          userId: "user-1",
        },
        {
          firstSyncId: "42",
          groups: ["workspace-1"],
          models: ["Task", "Team"],
          noSyncPackets: true,
          schemaHash: "abc",
          type: "partial",
        }
      );
    } finally {
      await app.close();
    }
  });

  it("rejects partial bootstrap requests without firstSyncId", async () => {
    const { app } = createApp();

    try {
      await app.ready();

      const response = await app.inject({
        headers: {
          authorization: "Bearer token",
        },
        method: "GET",
        url: "/sync/bootstrap?type=partial&schemaHash=abc",
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        details: [
          expect.objectContaining({
            message: "firstSyncId is required for partial bootstrap",
          }),
        ],
        error: "Validation failed",
      });
    } finally {
      await app.close();
    }
  });

  it("accepts non-UUID modelIds through the mutate route", async () => {
    const mutateService = makeMutateService();
    const { app, authMiddleware } = createApp({ mutateService });
    try {
      await app.ready();

      const response = await app.inject({
        headers: {
          authorization: "Bearer token",
        },
        method: "POST",
        payload: {
          batchId: "batch-1",
          transactions: [
            {
              action: "INSERT",
              clientId: "client-1",
              clientTxId: "tx-1",
              modelId: "task-1",
              modelName: "Task",
              payload: { title: "Hello" },
            },
          ],
        },
        url: "/sync/mutate",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        lastSyncId: "42",
        results: [{ clientTxId: "tx-1", success: true, syncId: "42" }],
        success: true,
      });
      expect(authMiddleware).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("returns BOOTSTRAP_REQUIRED when the delta cursor is stale", async () => {
    const deltaService = {
      fetchDeltas: vi.fn(),
      isCursorStale: vi.fn().mockResolvedValue(true),
    } as unknown as DeltaService;
    const { app } = createApp({ deltaService });
    try {
      await app.ready();

      const response = await app.inject({
        headers: {
          authorization: "Bearer token",
        },
        method: "GET",
        url: "/sync/deltas?after=1",
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: "BOOTSTRAP_REQUIRED",
        message: "A fresh bootstrap is required before fetching deltas",
      });
    } finally {
      await app.close();
    }
  });

  it("rejects oversized mutate payloads through the route", async () => {
    const { app } = createApp();
    try {
      await app.ready();

      const response = await app.inject({
        headers: {
          authorization: "Bearer token",
        },
        method: "POST",
        payload: {
          batchId: "batch-1",
          transactions: Array.from({ length: 101 }, (_, index) => ({
            action: "INSERT",
            clientId: "client-1",
            clientTxId: `tx-${index}`,
            modelId: `task-${index}`,
            modelName: "Task",
            payload: { title: "Hello" },
          })),
        },
        url: "/sync/mutate",
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toContain("At most 100 transactions are allowed");
    } finally {
      await app.close();
    }
  });
});
