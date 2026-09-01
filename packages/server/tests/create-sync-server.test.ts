import { pgTable, text } from "drizzle-orm/pg-core";

import type { SyncServerConfig } from "../src/config.js";
import { createSyncServer } from "../src/create-sync-server.js";
import type { SyncActionOutput } from "../src/types.js";

const makeLogger = () => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
});

const DELTA_CHANNEL = "sync:deltas";

const makeRedis = (publishImpl?: () => Promise<void>) => {
  const channelHandlers = new Map<string, (message: string) => void>();
  const subscriberRedis = {
    connect: vi.fn().mockResolvedValue(true),
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue(true),
    subscribe: vi.fn((channel: string, handler: (m: string) => void) => {
      channelHandlers.set(channel, handler);
      return Promise.resolve();
    }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
  const redis = {
    duplicate: vi.fn(() => subscriberRedis),
    publish: vi.fn(publishImpl ?? (() => Promise.resolve())),
  };
  return {
    emit: (message: string) => channelHandlers.get(DELTA_CHANNEL)?.(message),
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

const syncActionsTable = pgTable("sync_actions", {
  action: text("action"),
  clientId: text("client_id"),
  clientTxId: text("client_tx_id"),
  createdAt: text("created_at"),
  data: text("data"),
  groupId: text("group_id"),
  id: text("id").primaryKey(),
  model: text("model"),
  modelId: text("model_id"),
});

const syncGroupMembershipsTable = pgTable("sync_group_memberships", {
  groupId: text("group_id"),
  groupType: text("group_type"),
  id: text("id").primaryKey(),
  userId: text("user_id"),
});

/**
 * Config with a database double good enough for the group-change path:
 * a membership read, the advisory lock, and the sync-action insert.
 */
const groupConfig = (
  redis: unknown,
  logger: ReturnType<typeof makeLogger>,
  onCreate?: (row: Record<string, unknown>) => void
): SyncServerConfig => ({
  ...baseConfig(redis, logger),
  auth: {
    resolveGroups: vi.fn().mockResolvedValue(["resolved-group"]),
    verifyToken: vi.fn().mockResolvedValue(null),
  },
  db: {
    execute: () => Promise.resolve([]),
    insert: () => ({
      values: (data: Record<string, unknown>) => ({
        returning: () => {
          onCreate?.(data);
          return Promise.resolve([
            {
              ...data,
              createdAt: new Date("2024-06-15T12:00:00.000Z"),
              id: 1n,
            },
          ]);
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ groupId: "db-group" }]),
        }),
      }),
    }),
  } as never,
  tables: {
    syncActions: syncActionsTable,
    syncGroupMemberships: syncGroupMembershipsTable,
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

  it("notifyGroupsChanged publishes a durable group action to that user", async () => {
    const logger = makeLogger();
    const { redis } = makeRedis();

    const server = await createSyncServer(groupConfig(redis, logger));
    const received: { action: SyncActionOutput; groups: string[] }[] = [];
    server.deltaSubscriber.onDelta((action, groups) =>
      received.push({ action, groups })
    );

    await server.notifyGroupsChanged("user-a");

    expect(received).toHaveLength(1);
    const [entry] = received;
    // Addressed to the user's own group, which authorizeToken always includes.
    expect(entry?.groups).toEqual(["user-a"]);
    expect(entry?.action.groupId).toBe("user-a");
    expect(entry?.action.action).toBe("G");
    expect(entry?.action.modelName).toBe("__sync_groups__");
    // The list is recomputed from the same sources authorizeToken uses, so the
    // client is told exactly what it would get on reconnect.
    expect(entry?.action.data.subscribedSyncGroups).toEqual([
      "resolved-group",
      "db-group",
      "user-a",
    ]);

    await server.shutdown();
  });

  it("persists the group action so an offline user still receives it", async () => {
    const logger = makeLogger();
    const { redis } = makeRedis();
    const created: Record<string, unknown>[] = [];

    const server = await createSyncServer(
      groupConfig(redis, logger, (row) => created.push(row))
    );

    // No subscriber at all: the point of an in-band action over a frame is
    // that delivery does not depend on a socket being open right now.
    await server.notifyGroupsChanged("user-a");

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ action: "G", groupId: "user-a" });

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

describe("group change durability", () => {
  it("addresses the action to the changed user alone", async () => {
    // The whole reason this is an action and not a frame: it is written to
    // sync_actions with a syncId, scoped to one user's own group. Delivery is
    // therefore whatever the delta protocol already guarantees — live if
    // connected, replay or catch-up if not — rather than "only if a socket
    // happens to be open right now".
    const logger = makeLogger();
    const { redis } = makeRedis();
    const created: Record<string, unknown>[] = [];

    const server = await createSyncServer(
      groupConfig(redis, logger, (row) => created.push(row))
    );

    await server.notifyGroupsChanged("user-a");

    const [row] = created;
    expect(row?.groupId).toBe("user-a");
    // A null groupId would broadcast to everyone; a workspace group would leak
    // one user's membership list to their whole workspace.
    expect(row?.groupId).not.toBeNull();
    expect(row?.clientId).toBeNull();
    expect(row?.clientTxId).toBeNull();

    await server.shutdown();
  });

  it("survives redis being down", async () => {
    // Redis is best-effort for deltas and must be for this too: the action is
    // already committed, so a failed fan-out costs liveness, never the change.
    const logger = makeLogger();
    const { redis } = makeRedis(() => Promise.reject(new Error("redis down")));
    const created: Record<string, unknown>[] = [];

    const server = await createSyncServer(
      groupConfig(redis, logger, (row) => created.push(row))
    );

    await expect(server.notifyGroupsChanged("user-a")).resolves.toBeUndefined();
    expect(created).toHaveLength(1);

    await server.shutdown();
  });
});
