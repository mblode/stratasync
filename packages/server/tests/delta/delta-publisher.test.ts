import type { ControlFrame } from "../../src/delta/control-frames.js";
import { parseControlFrame } from "../../src/delta/control-frames.js";
import {
  createDeltaBus,
  createDeltaPublisher,
  createRedisDeltaTransport,
  safeJsonStringify,
} from "../../src/delta/delta-publisher.js";
import type { SyncActionOutput } from "../../src/types.js";

const makeSyncAction = (
  overrides?: Partial<SyncActionOutput>
): SyncActionOutput => ({
  action: "I",
  createdAt: new Date("2024-06-15T12:00:00.000Z"),
  data: { title: "Hello" },
  modelId: "task-1",
  modelName: "Task",
  syncId: "1",
  ...overrides,
});

const makeLogger = () => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
});

// ---------------------------------------------------------------------------
// safeJsonStringify
// ---------------------------------------------------------------------------

describe(safeJsonStringify, () => {
  it("stringifies plain objects", () => {
    expect(safeJsonStringify({ a: 1, b: "two" })).toBe('{"a":1,"b":"two"}');
  });

  it("converts bigints to strings", () => {
    expect(safeJsonStringify({ id: 42n })).toBe('{"id":"42"}');
  });

  it("handles nested bigints", () => {
    expect(safeJsonStringify({ outer: { inner: 100n } })).toBe(
      '{"outer":{"inner":"100"}}'
    );
  });

  it("handles arrays with bigints", () => {
    expect(safeJsonStringify([1n, 2n])).toBe('["1","2"]');
  });

  it("handles null and undefined", () => {
    expect(safeJsonStringify(null)).toBe("null");
    expect(safeJsonStringify()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DeltaBus
// ---------------------------------------------------------------------------

describe("DeltaBus", () => {
  it("delivers published actions to subscribers", () => {
    const bus = createDeltaBus();
    const received: { action: SyncActionOutput; groups: string[] }[] = [];
    bus.onDelta((action, groups) => {
      received.push({ action, groups });
    });

    const action = makeSyncAction();
    bus.publish(action, ["g1", "g2"]);

    expect(received).toHaveLength(1);
    expect(received[0]?.action).toBe(action);
    expect(received[0]?.groups).toEqual(["g1", "g2"]);
  });

  it("delivers to multiple subscribers", () => {
    const bus = createDeltaBus();
    const received1: SyncActionOutput[] = [];
    const received2: SyncActionOutput[] = [];

    bus.onDelta((action) => received1.push(action));
    bus.onDelta((action) => received2.push(action));

    bus.publish(makeSyncAction(), ["g1"]);

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
  });

  it("unsubscribe stops delivery", () => {
    const bus = createDeltaBus();
    const received: SyncActionOutput[] = [];
    const unsub = bus.onDelta((action) => received.push(action));

    bus.publish(makeSyncAction(), ["g1"]);
    expect(received).toHaveLength(1);

    unsub();
    bus.publish(makeSyncAction({ syncId: "2" }), ["g1"]);
    expect(received).toHaveLength(1);
  });

  it("continues delivery and warns when a callback throws", () => {
    const logger = makeLogger();
    const bus = createDeltaBus(logger);
    const received: SyncActionOutput[] = [];

    bus.onDelta(() => {
      throw new Error("callback error");
    });
    bus.onDelta((action) => received.push(action));

    bus.publish(makeSyncAction(), ["g1"]);
    expect(received).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("start/stop are noops", async () => {
    const bus = createDeltaBus();
    await bus.start();
    await bus.stop();
  });
});

// ---------------------------------------------------------------------------
// createDeltaPublisher (local-first composition)
// ---------------------------------------------------------------------------

describe(createDeltaPublisher, () => {
  it("delivers to the local bus when no redis is configured", async () => {
    const bus = createDeltaBus();
    const received: SyncActionOutput[] = [];
    bus.onDelta((action) => received.push(action));

    const publisher = createDeltaPublisher(bus);
    await publisher.publish(makeSyncAction(), ["g1"]);

    expect(received).toHaveLength(1);
  });

  it("publishMany publishes all actions to the bus", async () => {
    const bus = createDeltaBus();
    const received: SyncActionOutput[] = [];
    bus.onDelta((action) => received.push(action));

    const publisher = createDeltaPublisher(bus);
    await publisher.publishMany(
      [
        makeSyncAction({ syncId: "1" }),
        makeSyncAction({ syncId: "2" }),
        makeSyncAction({ syncId: "3" }),
      ],
      ["g1"]
    );

    expect(received.map((r) => r.syncId)).toEqual(["1", "2", "3"]);
  });

  it("publishes to both the bus and redis", async () => {
    const redisPublish = vi.fn().mockResolvedValue();
    const redis = { publish: redisPublish } as never;
    const bus = createDeltaBus();
    const transport = createRedisDeltaTransport(redis, bus, "source-1");
    const received: SyncActionOutput[] = [];
    bus.onDelta((action) => received.push(action));

    const publisher = createDeltaPublisher(bus, transport);
    await publisher.publish(makeSyncAction(), ["g1"]);

    expect(received).toHaveLength(1);
    expect(redisPublish).toHaveBeenCalledOnce();
  });

  it("still delivers locally and only warns when redis publish fails", async () => {
    const logger = makeLogger();
    const redis = {
      publish: vi.fn().mockRejectedValue(new Error("redis down")),
    } as never;
    const bus = createDeltaBus();
    const transport = createRedisDeltaTransport(redis, bus, "source-1", logger);
    const received: SyncActionOutput[] = [];
    bus.onDelta((action) => received.push(action));

    const publisher = createDeltaPublisher(bus, transport, logger);
    await publisher.publish(makeSyncAction(), ["g1"]);

    expect(received).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      event: "sync.delta.publish_partial_failure",
      failureCount: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// RedisDeltaTransport
// ---------------------------------------------------------------------------

// The transport subscribes per channel (deltas and control frames), so the
// double keys its handlers by channel exactly as redis does.
const DELTA_CHANNEL = "sync:deltas";
const CONTROL_CHANNEL = "sync:control";

const setupRedisTransport = () => {
  const channelHandlers = new Map<string, (message: string) => void>();
  const subscriberRedis = {
    connect: vi.fn().mockResolvedValue(),
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue(),
    subscribe: vi.fn((channel: string, handler: (m: string) => void) => {
      channelHandlers.set(channel, handler);
      return Promise.resolve();
    }),
    unsubscribe: vi.fn().mockResolvedValue(),
  };
  const redis = {
    duplicate: vi.fn(() => subscriberRedis),
    publish: vi.fn().mockResolvedValue(),
  };
  return {
    emit: (message: string) => channelHandlers.get(DELTA_CHANNEL)?.(message),
    emitControl: (message: string) =>
      channelHandlers.get(CONTROL_CHANNEL)?.(message),
    redis,
    subscriberRedis,
  };
};

const makeRedisMessage = (sourceId?: string, syncId = "5") =>
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
    ...(sourceId ? { sourceId } : {}),
  });

describe("RedisDeltaTransport", () => {
  const setup = setupRedisTransport;

  it("does not duplicate subscriptions when started twice", async () => {
    const { redis, subscriberRedis } = setup();
    const bus = createDeltaBus();
    const transport = createRedisDeltaTransport(
      redis as never,
      bus,
      "source-1"
    );

    await transport.start();
    await transport.start();
    await transport.stop();

    expect(redis.duplicate).toHaveBeenCalledOnce();
    expect(subscriberRedis.connect).toHaveBeenCalledOnce();
    // One subscribe/unsubscribe per channel: deltas and control frames.
    expect(subscriberRedis.subscribe).toHaveBeenCalledTimes(2);
    expect(subscriberRedis.unsubscribe).toHaveBeenCalledTimes(2);
    expect(subscriberRedis.quit).toHaveBeenCalledOnce();
  });

  it("relays inbound deltas into the local bus", async () => {
    const { redis, emit } = setup();
    const bus = createDeltaBus();
    const received: SyncActionOutput[] = [];
    bus.onDelta((action) => received.push(action));
    const transport = createRedisDeltaTransport(
      redis as never,
      bus,
      "source-1"
    );

    await transport.start();
    emit(makeRedisMessage("other-source", "9"));

    expect(received).toHaveLength(1);
    expect(received[0]?.syncId).toBe("9");
  });

  it("suppresses its own loopback messages", async () => {
    const { redis, emit } = setup();
    const bus = createDeltaBus();
    const received: SyncActionOutput[] = [];
    bus.onDelta((action) => received.push(action));
    const transport = createRedisDeltaTransport(
      redis as never,
      bus,
      "source-1"
    );

    await transport.start();
    emit(makeRedisMessage("source-1"));

    expect(received).toHaveLength(0);
  });

  it("warns and drops malformed redis messages", async () => {
    const logger = makeLogger();
    const { redis, emit } = setup();
    const bus = createDeltaBus();
    const received: SyncActionOutput[] = [];
    bus.onDelta((action) => received.push(action));
    const transport = createRedisDeltaTransport(
      redis as never,
      bus,
      "source-1",
      logger
    );

    await transport.start();
    emit("not json {");

    expect(received).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Control frames
// ---------------------------------------------------------------------------

describe("control frame transport", () => {
  it("relays inbound control frames into the local bus", async () => {
    const { emitControl, redis } = setupRedisTransport();
    const bus = createDeltaBus();
    const received: ControlFrame[] = [];
    bus.onControl((frame) => received.push(frame));
    const transport = createRedisDeltaTransport(
      redis as never,
      bus,
      "source-1"
    );

    await transport.start();
    emitControl(
      JSON.stringify({
        groupId: "proj-1",
        sourceId: "other-source",
        type: "group_left",
        userId: "user-a",
      })
    );

    expect(received).toEqual([
      { groupId: "proj-1", type: "group_left", userId: "user-a" },
    ]);
  });

  it("suppresses its own control loopback", async () => {
    const { emitControl, redis } = setupRedisTransport();
    const bus = createDeltaBus();
    const received: ControlFrame[] = [];
    bus.onControl((frame) => received.push(frame));
    const transport = createRedisDeltaTransport(
      redis as never,
      bus,
      "source-1"
    );

    await transport.start();
    emitControl(
      JSON.stringify({
        groupId: "proj-1",
        sourceId: "source-1",
        type: "group_left",
        userId: "user-a",
      })
    );

    expect(received).toHaveLength(0);
  });

  it("warns and drops a malformed control frame", async () => {
    const logger = makeLogger();
    const { emitControl, redis } = setupRedisTransport();
    const bus = createDeltaBus();
    const received: ControlFrame[] = [];
    bus.onControl((frame) => received.push(frame));
    const transport = createRedisDeltaTransport(
      redis as never,
      bus,
      "source-1",
      logger
    );

    await transport.start();
    emitControl(JSON.stringify({ groupId: "proj-1", type: "nonsense" }));

    expect(received).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("unsubscribing stops control delivery", () => {
    const bus = createDeltaBus();
    const received: ControlFrame[] = [];
    const unsub = bus.onControl((frame) => received.push(frame));

    const frame: ControlFrame = {
      groupId: "proj-1",
      type: "group_joined",
      userId: "user-a",
    };
    bus.publishControl(frame);
    expect(received).toHaveLength(1);

    unsub();
    bus.publishControl(frame);
    expect(received).toHaveLength(1);
  });
});

describe(parseControlFrame, () => {
  it("accepts a well-formed frame", () => {
    expect(
      parseControlFrame({
        groupId: "proj-1",
        type: "group_joined",
        userId: "user-a",
      })
    ).toEqual({ groupId: "proj-1", type: "group_joined", userId: "user-a" });
  });

  it.each([
    ["a non-object", 42],
    ["an unknown type", { groupId: "g", type: "group_exploded", userId: "u" }],
    ["a missing userId", { groupId: "g", type: "group_joined" }],
    ["an empty groupId", { groupId: "", type: "group_joined", userId: "u" }],
  ])("rejects %s", (_label, input) => {
    expect(() => parseControlFrame(input)).toThrow();
  });
});
