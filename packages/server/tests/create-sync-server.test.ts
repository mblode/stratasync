import type { SyncServerConfig } from "../src/config.js";
import { createSyncServer } from "../src/create-sync-server.js";
import type { SyncActionOutput } from "../src/types.js";

const makeLogger = () => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
});

const makeRedis = (publishImpl?: () => Promise<void>) => {
  let channelHandler: ((message: string) => void) | null = null;
  const subscriberRedis = {
    connect: vi.fn().mockResolvedValue(true),
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue(true),
    subscribe: vi.fn((_channel: string, handler: (m: string) => void) => {
      channelHandler = handler;
      return Promise.resolve();
    }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
  const redis = {
    duplicate: vi.fn(() => subscriberRedis),
    publish: vi.fn(publishImpl ?? (() => Promise.resolve())),
  };
  return {
    emit: (message: string) => channelHandler?.(message),
    redis,
    subscriberRedis,
  };
};

const baseConfig = (
  redis: unknown,
  logger: ReturnType<typeof makeLogger>
): SyncServerConfig => ({
  auth: {
    resolveGroups: vi.fn().mockResolvedValue([]),
    verifyToken: vi.fn().mockResolvedValue(null),
  },
  db: {} as never,
  logger,
  models: {},
  redis: redis as never,
  tables: {
    syncActions: {} as never,
    syncGroupMemberships: {} as never,
  },
});

const remoteDeltaMessage = (syncId: string) =>
  JSON.stringify({
    action: {
      action: "I",
      createdAt: "2024-06-15T12:00:00.000Z",
      data: { title: "Hi" },
      modelId: "task-1",
      modelName: "Task",
      syncId,
    },
    groups: ["g1"],
    sourceId: "another-process",
  });

describe(createSyncServer, () => {
  it("starts the redis subscriber transport", async () => {
    const logger = makeLogger();
    const { redis, subscriberRedis } = makeRedis();

    const server = await createSyncServer(baseConfig(redis, logger));

    expect(redis.duplicate).toHaveBeenCalledOnce();
    expect(subscriberRedis.connect).toHaveBeenCalledOnce();
    expect(subscriberRedis.subscribe).toHaveBeenCalledOnce();

    await server.shutdown();
    expect(subscriberRedis.unsubscribe).toHaveBeenCalledOnce();
    expect(subscriberRedis.quit).toHaveBeenCalledOnce();
  });

  it("relays inbound redis deltas into the local subscriber", async () => {
    const logger = makeLogger();
    const { redis, emit } = makeRedis();

    const server = await createSyncServer(baseConfig(redis, logger));
    const received: SyncActionOutput[] = [];
    server.deltaSubscriber.onDelta((action) => received.push(action));

    emit(remoteDeltaMessage("9"));

    expect(received).toHaveLength(1);
    expect(received[0]?.syncId).toBe("9");

    await server.shutdown();
  });

  it("warns and drops malformed redis messages without crashing", async () => {
    const logger = makeLogger();
    const { redis, emit } = makeRedis();

    const server = await createSyncServer(baseConfig(redis, logger));
    const received: SyncActionOutput[] = [];
    server.deltaSubscriber.onDelta((action) => received.push(action));

    emit("}{ not json");

    expect(received).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();

    await server.shutdown();
  });

  it("delivers locally even when the redis publish fails", async () => {
    const logger = makeLogger();
    const { redis } = makeRedis(() => Promise.reject(new Error("redis down")));

    const server = await createSyncServer(baseConfig(redis, logger));
    const received: SyncActionOutput[] = [];
    server.deltaSubscriber.onDelta((action) => received.push(action));

    const action: SyncActionOutput = {
      action: "I",
      createdAt: new Date("2024-06-15T12:00:00.000Z"),
      data: {},
      modelId: "task-1",
      modelName: "Task",
      syncId: "5",
    };

    await server.deltaPublisher.publish(action, ["g1"]);

    expect(received).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "sync.delta.publish_partial_failure",
      }),
      expect.any(String)
    );

    await server.shutdown();
  });

  it("works without redis (in-memory bus only)", async () => {
    const logger = makeLogger();
    const server = await createSyncServer({
      ...baseConfig(undefined, logger),
      redis: undefined,
    });

    const received: SyncActionOutput[] = [];
    server.deltaSubscriber.onDelta((action) => received.push(action));

    await server.deltaPublisher.publish(
      {
        action: "I",
        createdAt: new Date("2024-06-15T12:00:00.000Z"),
        data: {},
        modelId: "task-1",
        modelName: "Task",
        syncId: "1",
      },
      ["g1"]
    );

    expect(received).toHaveLength(1);
    await server.shutdown();
  });
});
