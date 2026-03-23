// oxlint-disable max-classes-per-file -- test file with mock classes
import { EventEmitter } from "node:events";

import type { WebSocketHooks } from "../../src/config.js";
import type { DeltaSubscriberLike } from "../../src/delta/delta-publisher.js";
import { registerSyncWebsocket } from "../../src/websocket/sync-websocket.js";

type MessageRecord = Record<string, unknown>;

// oxlint-disable-next-line prefer-event-target -- Node.js EventEmitter required for WebSocket mock compatibility
class MockWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly OPEN = MockWebSocket.OPEN;
  readonly CLOSED = MockWebSocket.CLOSED;

  readyState = MockWebSocket.OPEN;
  readonly sent: string[] = [];
  readonly closeCalls: { code?: number; reason?: string }[] = [];
  readonly pingCalls: number[] = [];

  send(message: string): void {
    this.sent.push(message);
  }

  ping(): void {
    this.pingCalls.push(Date.now());
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.readyState === MockWebSocket.CLOSED) {
      return;
    }
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close");
  }
}

class MockDeltaSubscriber implements DeltaSubscriberLike {
  callback: ((action: unknown, groups: string[]) => void) | null = null;

  // oxlint-disable-next-line no-empty-function -- mock stub
  async start(): Promise<void> {}

  // oxlint-disable-next-line no-empty-function -- mock stub
  async stop(): Promise<void> {}

  // oxlint-disable-next-line prefer-await-to-callbacks -- callback is a subscription handler, not a Node-style callback
  onDelta(callback: (action: unknown, groups: string[]) => void): () => void {
    this.callback = callback;
    return () => {
      if (this.callback === callback) {
        this.callback = null;
      }
    };
  }

  emit(action: unknown, groups: string[]): void {
    this.callback?.(action, groups);
  }
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const waitForAssertion = async (
  assertion: () => void,
  timeoutMs = 1000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      // oxlint-disable-next-line avoid-new -- micro-tick delay for polling
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  }
};

const parseMessage = (message: string): MessageRecord =>
  JSON.parse(message) as MessageRecord;

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  // oxlint-disable-next-line avoid-new, param-names -- deferred promise pattern
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const createReplayAction = (id: bigint) => ({
  action: "I",
  clientId: null,
  clientTxId: null,
  createdAt: new Date("2024-06-15T12:00:00.000Z"),
  data: { title: "Hello" },
  groupId: null,
  id,
  model: "Task",
  modelId: "task-1",
});

const setup = (overrides?: {
  deltaSubscriber?: MockDeltaSubscriber;
  getSyncActions?: () => Promise<unknown[]>;
  getUserGroups?: () => Promise<string[]>;
  getEarliestSyncId?: () => Promise<bigint>;
  resolveGroups?: (userId: string) => Promise<string[]>;
  verifyToken?: (token: string) => Promise<{ userId: string } | null>;
  onClose?: WebSocketHooks["onClose"];
}) => {
  let routeHandler: ((socket: MockWebSocket) => void) | null = null;
  const server = {
    get: vi.fn(
      (
        _path: string,
        _opts: unknown,
        handler: (socket: MockWebSocket) => void
      ) => {
        routeHandler = handler;
      }
    ),
  };

  const socket = new MockWebSocket();
  const deltaSubscriber =
    overrides?.deltaSubscriber ?? new MockDeltaSubscriber();
  const verifyToken =
    overrides?.verifyToken ?? vi.fn().mockResolvedValue({ userId: "user-1" });
  const resolveGroups =
    overrides?.resolveGroups ?? vi.fn().mockResolvedValue([]);
  const getUserGroups =
    overrides?.getUserGroups ?? vi.fn().mockResolvedValue([]);
  const getSyncActions =
    overrides?.getSyncActions ?? vi.fn().mockResolvedValue([]);
  const getEarliestSyncId =
    overrides?.getEarliestSyncId ?? vi.fn().mockResolvedValue(0n);
  const onClose = overrides?.onClose;
  const auth = {
    resolveGroups,
    verifyToken,
  };
  const syncDao = {
    getEarliestSyncId,
    getSyncActions,
    getUserGroups,
  } as unknown as Parameters<typeof registerSyncWebsocket>[1]["syncDao"];
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

  registerSyncWebsocket(server as never, {
    auth,
    deltaSubscriber,
    hooks: onClose ? { onClose } : undefined,
    logger,
    syncDao,
  });

  if (!routeHandler) {
    throw new Error("WebSocket route handler was not registered");
  }

  routeHandler(socket);

  return {
    auth,
    deltaSubscriber,
    getSyncActions,
    getUserGroups,
    logger,
    routeHandler,
    socket,
    syncDao,
    verifyToken,
  };
};

describe(registerSyncWebsocket, () => {
  it("replays missed actions before sending subscribed", async () => {
    const harness = setup({
      getSyncActions: vi
        .fn()
        .mockResolvedValueOnce([createReplayAction(1n)])
        .mockResolvedValueOnce([]),
    });

    harness.socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          afterSyncId: "0",
          groups: [],
          token: "tok",
          type: "subscribe",
        })
      )
    );

    await waitForAssertion(() => {
      expect(harness.socket.sent).toHaveLength(2);
    });

    expect(parseMessage(harness.socket.sent[0]).type).toBe("delta");
    expect(parseMessage(harness.socket.sent[1]).type).toBe("subscribed");
    expect(harness.socket.closeCalls).toHaveLength(0);
  });

  it("requires a fresh bootstrap when the requested syncId is too old", async () => {
    const deltaSubscriber = new MockDeltaSubscriber();
    // oxlint-disable-next-line prefer-await-to-callbacks -- mock callback pattern
    deltaSubscriber.onDelta = vi.fn((_callback) => () => {
      /* noop */
    });

    const harness = setup({
      deltaSubscriber,
      getEarliestSyncId: vi.fn().mockResolvedValue(10n),
    });

    harness.socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          afterSyncId: "5",
          token: "tok",
          type: "subscribe",
        })
      )
    );

    await waitForAssertion(() => {
      expect(harness.socket.sent).toHaveLength(1);
    });

    const message = parseMessage(harness.socket.sent[0]);
    expect(message).toMatchObject({
      code: "BOOTSTRAP_REQUIRED",
      type: "error",
    });
    expect(harness.socket.closeCalls).toHaveLength(0);
    expect(deltaSubscriber.onDelta).not.toHaveBeenCalled();
  });

  it("merges auth and DAO groups before acknowledging the subscription", async () => {
    const resolveGroups = vi
      .fn()
      .mockResolvedValue(["workspace-1", "workspace-2"]);
    const getUserGroups = vi
      .fn()
      .mockResolvedValue(["workspace-2", "workspace-3"]);
    const harness = setup({
      getUserGroups,
      resolveGroups,
    });

    harness.socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          afterSyncId: "0",
          token: "tok",
          type: "subscribe",
        })
      )
    );

    await waitForAssertion(() => {
      expect(harness.socket.sent).toHaveLength(1);
    });

    expect(resolveGroups).toHaveBeenCalledWith("user-1");
    expect(getUserGroups).toHaveBeenCalledWith("user-1");
    expect(parseMessage(harness.socket.sent[0])).toEqual({
      afterSyncId: "0",
      groups: ["workspace-1", "workspace-2", "workspace-3", "user-1"],
      type: "subscribed",
    });
  });

  it("closes the socket when websocket group resolution fails", async () => {
    const resolveGroups = vi.fn().mockRejectedValue(new Error("boom"));
    const harness = setup({ resolveGroups });

    harness.socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          afterSyncId: "0",
          token: "tok",
          type: "subscribe",
        })
      )
    );

    await waitForAssertion(() => {
      expect(harness.socket.closeCalls).toHaveLength(1);
    });

    expect(parseMessage(harness.socket.sent[0])).toEqual({
      message: "Failed to resolve sync groups",
      type: "error",
    });
    expect(harness.socket.closeCalls[0]).toMatchObject({
      code: 1011,
      reason: "Failed to resolve sync groups",
    });
  });

  it("serializes subscribe messages with a mutex", async () => {
    const deferred = createDeferred<unknown[]>();
    // oxlint-disable-next-line require-await -- async needed for mock return type
    const verifyToken = vi.fn(async (token: string) => ({ userId: token }));
    const harness = setup({
      getSyncActions: vi.fn().mockImplementation(() => deferred.promise),
      verifyToken,
    });

    harness.socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          afterSyncId: "0",
          token: "tok-1",
          type: "subscribe",
        })
      )
    );
    harness.socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          afterSyncId: "0",
          token: "tok-2",
          type: "subscribe",
        })
      )
    );

    await flush();
    expect(verifyToken).toHaveBeenCalledOnce();

    deferred.resolve([]);

    await waitForAssertion(() => {
      expect(verifyToken).toHaveBeenCalledTimes(2);
    });
  });

  it("closes the socket when the replay buffer overflows", async () => {
    const deferred = createDeferred<unknown[]>();
    const deltaSubscriber = new MockDeltaSubscriber();
    const harness = setup({
      deltaSubscriber,
      getSyncActions: vi.fn().mockImplementation(() => deferred.promise),
    });

    harness.socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          afterSyncId: "0",
          token: "tok",
          type: "subscribe",
        })
      )
    );

    await waitForAssertion(() => {
      expect(deltaSubscriber.callback).toBeTruthy();
    });

    for (let index = 1; index <= 10_001; index += 1) {
      deltaSubscriber.emit(
        {
          action: "I",
          createdAt: new Date("2024-06-15T12:00:00.000Z"),
          data: {},
          modelId: "task-1",
          modelName: "Task",
          syncId: String(index),
        },
        []
      );
    }

    deferred.resolve([]);

    await waitForAssertion(() => {
      expect(harness.socket.closeCalls).toHaveLength(1);
    });

    expect(harness.socket.closeCalls[0]).toMatchObject({
      code: 4008,
      reason: "Replay buffer limit exceeded",
    });
    expect(parseMessage(harness.socket.sent[0])).toMatchObject({
      code: "BUFFER_OVERFLOW",
      type: "error",
    });
    expect(
      harness.socket.sent.some(
        (message) => parseMessage(message).type === "subscribed"
      )
    ).toBeFalsy();
  });

  it("runs cleanup once even if error and close both fire", async () => {
    const onClose = vi.fn().mockResolvedValue();
    const harness = setup({ onClose });

    harness.socket.emit("error", new Error("boom"));
    harness.socket.emit("close");

    await waitForAssertion(() => {
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  it("closes stalled sockets when heartbeat pongs stop", async () => {
    vi.useFakeTimers();

    try {
      const harness = setup();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(harness.socket.pingCalls).toHaveLength(1);
      expect(harness.socket.closeCalls).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(30_000);

      expect(harness.socket.closeCalls).toHaveLength(1);
      expect(harness.socket.closeCalls[0]).toMatchObject({
        code: 1011,
        reason: "Heartbeat timeout",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
