import {
  createCompositeDeltaPublisher,
  createDeltaSubscriber,
  createInMemoryDeltaBus,
  createInMemoryDeltaPublisher,
  createInMemoryDeltaSubscriber,
  safeJsonStringify,
} from "../../src/delta/delta-publisher.js";
import type { DeltaPublisherLike } from "../../src/delta/delta-publisher.js";
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

// ---------------------------------------------------------------------------
// safeJsonStringify
// ---------------------------------------------------------------------------

describe(safeJsonStringify, () => {
  it("stringifies plain objects", () => {
    expect(safeJsonStringify({ a: 1, b: "two" })).toBe('{"a":1,"b":"two"}');
  });

  it("converts bigints to strings", () => {
    const result = safeJsonStringify({ id: 42n });
    expect(result).toBe('{"id":"42"}');
  });

  it("handles nested bigints", () => {
    const result = safeJsonStringify({ outer: { inner: 100n } });
    expect(result).toBe('{"outer":{"inner":"100"}}');
  });

  it("handles arrays with bigints", () => {
    const result = safeJsonStringify([1n, 2n]);
    expect(result).toBe('["1","2"]');
  });

  it("handles null and undefined", () => {
    expect(safeJsonStringify(null)).toBe("null");
    expect(safeJsonStringify()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// InMemoryDeltaBus + Publisher + Subscriber
// ---------------------------------------------------------------------------

describe("InMemoryDeltaBus", () => {
  let bus: ReturnType<typeof createInMemoryDeltaBus>;
  let publisher: ReturnType<typeof createInMemoryDeltaPublisher>;
  let subscriber: ReturnType<typeof createInMemoryDeltaSubscriber>;

  beforeEach(() => {
    bus = createInMemoryDeltaBus();
    publisher = createInMemoryDeltaPublisher(bus);
    subscriber = createInMemoryDeltaSubscriber(bus);
  });

  it("delivers published actions to subscribers", () => {
    const received: { action: SyncActionOutput; groups: string[] }[] = [];
    subscriber.onDelta((action, groups) => {
      received.push({ action, groups });
    });

    const action = makeSyncAction();
    publisher.publish(action, ["g1", "g2"]);

    expect(received).toHaveLength(1);
    const [first] = received;
    expect(first).toBeDefined();
    expect(first?.action).toBe(action);
    expect(first?.groups).toEqual(["g1", "g2"]);
  });

  it("delivers to multiple subscribers", () => {
    const received1: SyncActionOutput[] = [];
    const received2: SyncActionOutput[] = [];

    subscriber.onDelta((action) => received1.push(action));
    subscriber.onDelta((action) => received2.push(action));

    const action = makeSyncAction();
    publisher.publish(action, ["g1"]);

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
  });

  it("unsubscribe stops delivery", () => {
    const received: SyncActionOutput[] = [];
    const unsub = subscriber.onDelta((action) => received.push(action));

    publisher.publish(makeSyncAction(), ["g1"]);
    expect(received).toHaveLength(1);

    unsub();

    publisher.publish(makeSyncAction({ syncId: "2" }), ["g1"]);
    expect(received).toHaveLength(1);
  });

  it("continues delivery when a callback throws", () => {
    const received: SyncActionOutput[] = [];

    subscriber.onDelta(() => {
      throw new Error("callback error");
    });
    subscriber.onDelta((action) => received.push(action));

    publisher.publish(makeSyncAction(), ["g1"]);
    expect(received).toHaveLength(1);
  });

  it("publishMany publishes all actions", async () => {
    const received: SyncActionOutput[] = [];
    subscriber.onDelta((action) => received.push(action));

    const actions = [
      makeSyncAction({ syncId: "1" }),
      makeSyncAction({ syncId: "2" }),
      makeSyncAction({ syncId: "3" }),
    ];

    await publisher.publishMany(actions, ["g1"]);
    expect(received).toHaveLength(3);
    expect(received.map((r) => r.syncId)).toEqual(["1", "2", "3"]);
  });

  it("subscriber start/stop are noops for in-memory", async () => {
    // Should not throw
    await subscriber.start();
    await subscriber.stop();
  });
});

// ---------------------------------------------------------------------------
// CompositeDeltaPublisher
// ---------------------------------------------------------------------------

describe("CompositeDeltaPublisher", () => {
  let mockLogger: {
    debug: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
  });

  const createMockPublisher = (
    shouldFail = false
  ): DeltaPublisherLike & {
    calls: { action: SyncActionOutput; groups: string[] }[];
  } => {
    const calls: { action: SyncActionOutput; groups: string[] }[] = [];
    return {
      calls,
      publish(action: SyncActionOutput, groups: string[]) {
        if (shouldFail) {
          throw new Error("publish failed");
        }
        calls.push({ action, groups });
        return Promise.resolve();
      },
      async publishMany(actions: SyncActionOutput[], groups: string[]) {
        for (const action of actions) {
          await this.publish(action, groups);
        }
      },
    };
  };

  it("publishes to all backends", async () => {
    const pub1 = createMockPublisher();
    const pub2 = createMockPublisher();
    const composite = createCompositeDeltaPublisher([pub1, pub2], mockLogger);

    const action = makeSyncAction();
    await composite.publish(action, ["g1"]);

    expect(pub1.calls).toHaveLength(1);
    expect(pub2.calls).toHaveLength(1);
  });

  it("continues publishing when one backend fails", async () => {
    const failing = createMockPublisher(true);
    const working = createMockPublisher();
    const composite = createCompositeDeltaPublisher(
      [failing, working],
      mockLogger
    );

    const action = makeSyncAction();
    await composite.publish(action, ["g1"]);

    expect(working.calls).toHaveLength(1);
  });

  it("logs a warning when one backend fails", async () => {
    const failing = createMockPublisher(true);
    const working = createMockPublisher();
    const composite = createCompositeDeltaPublisher(
      [failing, working],
      mockLogger
    );

    await composite.publish(makeSyncAction(), ["g1"]);

    expect(mockLogger.warn).toHaveBeenCalledOnce();
    expect(mockLogger.warn.mock.calls).toHaveLength(1);
    const [warnCall] = mockLogger.warn.mock.calls;
    expect(warnCall).toBeDefined();
    expect(warnCall?.[0]).toMatchObject({
      event: "sync.delta.publish_partial_failure",
      failureCount: 1,
    });
  });

  it("throws when ALL backends fail", async () => {
    const failing1 = createMockPublisher(true);
    const failing2 = createMockPublisher(true);
    const composite = createCompositeDeltaPublisher(
      [failing1, failing2],
      mockLogger
    );

    await expect(composite.publish(makeSyncAction(), ["g1"])).rejects.toThrow(
      "publish failed"
    );
  });

  it("publishMany calls publish for each action", async () => {
    const pub = createMockPublisher();
    const composite = createCompositeDeltaPublisher([pub], mockLogger);

    const actions = [
      makeSyncAction({ syncId: "1" }),
      makeSyncAction({ syncId: "2" }),
    ];

    await composite.publishMany(actions, ["g1"]);
    expect(pub.calls).toHaveLength(2);
  });
});

describe("DeltaSubscriber", () => {
  it("does not duplicate Redis subscriptions when started twice", async () => {
    const subscriberRedis = {
      connect: vi.fn().mockResolvedValue(),
      on: vi.fn(),
      quit: vi.fn().mockResolvedValue(),
      subscribe: vi.fn().mockResolvedValue(),
      unsubscribe: vi.fn().mockResolvedValue(),
    };
    const redis = {
      duplicate: vi.fn(() => subscriberRedis),
    };

    const subscriber = createDeltaSubscriber(redis as never);

    await subscriber.start();
    await subscriber.start();
    await subscriber.stop();

    expect(redis.duplicate).toHaveBeenCalledOnce();
    expect(subscriberRedis.connect).toHaveBeenCalledOnce();
    expect(subscriberRedis.subscribe).toHaveBeenCalledOnce();
    expect(subscriberRedis.unsubscribe).toHaveBeenCalledOnce();
    expect(subscriberRedis.quit).toHaveBeenCalledOnce();
  });
});
