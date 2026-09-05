// oxlint-disable max-classes-per-file -- test file with mock classes
import { EventEmitter } from "node:events";

import type { SyncAuthConfig, WebSocketHooks } from "../../src/config.js";
import { BOOTSTRAP_REQUIRED_WS_MESSAGE } from "../../src/core/errors.js";
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

const createLiveAction = (syncId: string) => ({
  action: "I",
  createdAt: new Date("2024-06-15T12:00:00.000Z"),
  data: {},
  modelId: `task-${syncId}`,
  modelName: "Task",
  syncId,
});

// oxlint-disable-next-line eslint/complexity -- one route harness exposes independent auth, replay, transport, and lifecycle seams
const setup = (overrides?: {
  deltaSubscriber?: MockDeltaSubscriber;
  getSyncActions?: () => Promise<unknown[]>;
  getUserGroups?: () => Promise<string[]>;
  getEarliestSyncId?: () => Promise<bigint>;
  getLastSyncIdForGroups?: () => Promise<bigint>;
  getSyncGroupActions?: () => Promise<unknown[]>;
  resolveGroups?: (userId: string) => Promise<string[]>;
  verifyToken?: SyncAuthConfig["verifyToken"];
  authorizeAccess?: SyncAuthConfig["authorizeAccess"];
  groupResolutionMode?: SyncAuthConfig["groupResolutionMode"];
  reauthorizeBeforeWebSocketDelivery?: boolean;
  webSocketGroupRefreshCatchUpIntervalMs?: number;
  onClose?: WebSocketHooks["onClose"];
  onMessage?: WebSocketHooks["onMessage"];
  onSubscribe?: WebSocketHooks["onSubscribe"];
}) => {
  let routeHandler:
    | ((socket: MockWebSocket, request?: Record<string, unknown>) => void)
    | null = null;
  let routeOptions: Record<string, unknown> | null = null;
  const server = {
    get: vi.fn(
      (
        _path: string,
        opts: Record<string, unknown>,
        handler: (
          socket: MockWebSocket,
          request?: Record<string, unknown>
        ) => void
      ) => {
        routeOptions = opts;
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
  const getLastSyncIdForGroups =
    overrides?.getLastSyncIdForGroups ?? vi.fn().mockResolvedValue(0n);
  const getSyncGroupActions =
    overrides?.getSyncGroupActions ?? vi.fn().mockResolvedValue([]);
  const auth = {
    ...(overrides?.authorizeAccess
      ? { authorizeAccess: overrides.authorizeAccess }
      : {}),
    ...(overrides?.groupResolutionMode
      ? { groupResolutionMode: overrides.groupResolutionMode }
      : {}),
    resolveGroups,
    ...(overrides?.reauthorizeBeforeWebSocketDelivery
      ? { reauthorizeBeforeWebSocketDelivery: true }
      : {}),
    ...(overrides?.webSocketGroupRefreshCatchUpIntervalMs
      ? {
          webSocketGroupRefreshCatchUpIntervalMs:
            overrides.webSocketGroupRefreshCatchUpIntervalMs,
        }
      : {}),
    verifyToken,
  };
  const syncDao = {
    getEarliestSyncId,
    getLastSyncIdForGroups,
    getSyncActions,
    getSyncGroupActions,
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
    hooks: {
      onClose: overrides?.onClose,
      onMessage: overrides?.onMessage,
      onSubscribe: overrides?.onSubscribe,
    },
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
    getSyncGroupActions,
    getUserGroups,
    logger,
    routeHandler,
    routeOptions,
    socket,
    syncDao,
    verifyToken,
  };
};

describe(registerSyncWebsocket, () => {
  it("authorizes a Bearer credential once during upgrade", async () => {
    const verifyToken = vi.fn().mockResolvedValue({ userId: "user-1" });
    const harness = setup({ verifyToken });
    const preValidation = harness.routeOptions?.preValidation as (
      request: Record<string, unknown>,
      reply: unknown
    ) => Promise<void>;
    const request = {
      headers: { authorization: "Bearer header-token" },
      query: {},
    };
    const send = vi.fn();
    const reply = { code: vi.fn().mockReturnValue({ send }) };

    await preValidation(request, reply);

    expect(request).toMatchObject({
      syncToken: "header-token",
      syncUser: { groups: ["user-1"], userId: "user-1" },
    });
    expect(verifyToken).toHaveBeenCalledOnce();
    expect(verifyToken).toHaveBeenCalledWith("header-token");
    expect(reply.code).not.toHaveBeenCalled();

    const connectedSocket = new MockWebSocket();
    harness.routeHandler(connectedSocket, request);
    connectedSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ token: "ignored-frame-token", type: "subscribe" })
      )
    );
    await waitForAssertion(() => {
      expect(connectedSocket.sent).toHaveLength(1);
    });
    expect(verifyToken).toHaveBeenCalledOnce();
  });

  it("rejects a policy-denied credential before WebSocket upgrade", async () => {
    const harness = setup({
      authorizeAccess: vi.fn().mockResolvedValue(false),
      verifyToken: vi.fn().mockResolvedValue({
        principal: { keyId: "denied" },
        userId: "user-1",
      }),
    });
    const preValidation = harness.routeOptions?.preValidation as (
      request: Record<string, unknown>,
      reply: unknown
    ) => Promise<void>;
    const send = vi.fn();
    const code = vi.fn().mockReturnValue({ send });

    await preValidation(
      { headers: { authorization: "Bearer denied" }, query: {} },
      { code }
    );

    expect(code).toHaveBeenCalledWith(403);
    expect(send).toHaveBeenCalledWith({ error: "Access denied" });
  });

  it("rejects conflicting WebSocket header and query credentials", async () => {
    const harness = setup();
    const preValidation = harness.routeOptions?.preValidation as (
      request: Record<string, unknown>,
      reply: unknown
    ) => Promise<void>;
    const send = vi.fn();
    const code = vi.fn().mockReturnValue({ send });

    await preValidation(
      {
        headers: { authorization: "Bearer header-token" },
        query: { token: "query-token" },
      },
      { code }
    );

    expect(code).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalledWith({
      error: "Conflicting WebSocket credentials",
    });
  });

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

  it("bypasses stored memberships in authoritative group-resolution mode", async () => {
    const getUserGroups = vi.fn().mockResolvedValue(["stale-workspace"]);
    const harness = setup({
      getUserGroups,
      groupResolutionMode: "authoritative",
      resolveGroups: vi.fn().mockResolvedValue(["live-workspace"]),
    });

    harness.socket.emit(
      "message",
      Buffer.from(JSON.stringify({ token: "tok", type: "subscribe" }))
    );

    await waitForAssertion(() => {
      expect(harness.socket.sent).toHaveLength(1);
    });
    expect(getUserGroups).not.toHaveBeenCalled();
    expect(parseMessage(harness.socket.sent[0])).toEqual({
      afterSyncId: "0",
      groups: ["live-workspace", "user-1"],
      type: "subscribed",
    });
  });

  it("retains the principal and final allowed groups on every subscribe", async () => {
    const principal = { keyId: "key-1" };
    const authorizeAccess = vi.fn().mockResolvedValue({
      allowedGroups: ["workspace-1", "forged-group", "user-1"],
    });
    const onMessage = vi.fn().mockResolvedValue(true);
    const harness = setup({
      authorizeAccess,
      getUserGroups: vi.fn().mockResolvedValue(["workspace-2"]),
      onMessage,
      resolveGroups: vi.fn().mockResolvedValue(["workspace-1"]),
      verifyToken: vi.fn().mockResolvedValue({ principal, userId: "user-1" }),
    });
    const subscribe = () => {
      harness.socket.emit(
        "message",
        Buffer.from(JSON.stringify({ token: "tok", type: "subscribe" }))
      );
    };

    subscribe();
    await waitForAssertion(() => {
      expect(authorizeAccess).toHaveBeenCalledOnce();
      expect(harness.socket.sent).toHaveLength(1);
    });
    subscribe();
    await waitForAssertion(() => {
      expect(authorizeAccess).toHaveBeenCalledTimes(2);
      expect(harness.socket.sent).toHaveLength(2);
    });

    expect(parseMessage(harness.socket.sent[1])).toMatchObject({
      groups: ["workspace-1", "user-1"],
      type: "subscribed",
    });

    harness.socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "custom" }))
    );
    await waitForAssertion(() => {
      expect(onMessage).toHaveBeenCalledOnce();
    });
    expect(onMessage).toHaveBeenCalledWith(
      harness.socket,
      { type: "custom" },
      expect.objectContaining({
        groups: ["workspace-1", "user-1"],
        principal,
        userId: "user-1",
      })
    );
  });

  it("passes the authenticated principal to the subscribe hook", async () => {
    const principal = { keyId: "key-1" };
    const onSubscribe = vi.fn().mockResolvedValue();
    const harness = setup({
      authorizeAccess: vi.fn().mockResolvedValue({
        allowedGroups: ["workspace-1", "user-1"],
      }),
      onSubscribe,
      resolveGroups: vi.fn().mockResolvedValue(["workspace-1"]),
      verifyToken: vi.fn().mockResolvedValue({ principal, userId: "user-1" }),
    });

    harness.socket.emit(
      "message",
      Buffer.from(JSON.stringify({ token: "tok", type: "subscribe" }))
    );

    await waitForAssertion(() => {
      expect(onSubscribe).toHaveBeenCalledOnce();
    });
    expect(onSubscribe).toHaveBeenCalledWith(
      harness.socket,
      expect.objectContaining({
        groups: ["workspace-1", "user-1"],
        principal,
        userId: "user-1",
      }),
      expect.objectContaining({ groups: [] })
    );
  });

  it("scopes durable group refresh actions to the session's allowed groups", async () => {
    const deltaSubscriber = new MockDeltaSubscriber();
    const harness = setup({
      authorizeAccess: vi.fn().mockResolvedValue({
        allowedGroups: ["workspace-1", "user-1"],
      }),
      deltaSubscriber,
      resolveGroups: vi.fn().mockResolvedValue(["workspace-1", "workspace-2"]),
      verifyToken: vi
        .fn()
        .mockResolvedValue({ principal: { keyId: "key-1" }, userId: "user-1" }),
    });

    harness.socket.emit(
      "message",
      Buffer.from(JSON.stringify({ token: "tok", type: "subscribe" }))
    );
    await waitForAssertion(() => {
      expect(deltaSubscriber.callback).toBeTruthy();
    });

    deltaSubscriber.emit(
      {
        ...createLiveAction("1"),
        action: "G",
        data: {
          subscribedSyncGroups: ["workspace-1", "workspace-2", "user-1"],
        },
        modelName: "__sync_groups__",
      },
      ["user-1"]
    );

    await waitForAssertion(() => {
      expect(harness.socket.sent).toHaveLength(2);
    });
    const refresh = parseMessage(harness.socket.sent[1]);
    expect(
      (refresh.packet as { actions: { data: unknown }[] }).actions[0]?.data
    ).toEqual({ subscribedSyncGroups: ["workspace-1", "user-1"] });
  });

  it("reauthorizes before live delivery when the durable group notification is lost", async () => {
    let resolvedGroups = ["workspace-1", "workspace-2"];
    const verifyToken = vi.fn().mockResolvedValue({ userId: "user-1" });
    const harness = setup({
      deltaSubscriber: new MockDeltaSubscriber(),
      reauthorizeBeforeWebSocketDelivery: true,
      resolveGroups: vi
        .fn()
        .mockImplementation(() => Promise.resolve(resolvedGroups)),
      verifyToken,
    });

    harness.socket.emit(
      "message",
      Buffer.from(JSON.stringify({ token: "tok", type: "subscribe" }))
    );
    await waitForAssertion(() => {
      expect(harness.socket.sent).toHaveLength(1);
      expect(verifyToken).toHaveBeenCalledTimes(2);
    });

    resolvedGroups = ["workspace-1"];
    harness.deltaSubscriber.emit(
      { ...createLiveAction("1"), groupId: "workspace-2" },
      ["workspace-2"]
    );
    await waitForAssertion(() => {
      expect(verifyToken).toHaveBeenCalledTimes(3);
    });
    expect(harness.socket.sent).toHaveLength(1);

    harness.deltaSubscriber.emit(
      { ...createLiveAction("2"), groupId: "workspace-1" },
      ["workspace-1"]
    );
    await waitForAssertion(() => {
      expect(harness.socket.sent).toHaveLength(2);
    });
    expect(parseMessage(harness.socket.sent[1])).toMatchObject({
      packet: { actions: [{ groupId: "workspace-1", syncId: "2" }] },
      type: "delta",
    });
  });

  it("sends full newly authorized groups in G without widening the live session", async () => {
    let resolvedGroups = ["workspace-1"];
    const harness = setup({
      deltaSubscriber: new MockDeltaSubscriber(),
      reauthorizeBeforeWebSocketDelivery: true,
      resolveGroups: vi
        .fn()
        .mockImplementation(() => Promise.resolve(resolvedGroups)),
    });

    harness.socket.emit(
      "message",
      Buffer.from(JSON.stringify({ token: "tok", type: "subscribe" }))
    );
    await waitForAssertion(() => {
      expect(harness.socket.sent).toHaveLength(1);
    });

    resolvedGroups = ["workspace-1", "workspace-3"];
    harness.deltaSubscriber.emit(
      {
        ...createLiveAction("1"),
        action: "G",
        data: { subscribedSyncGroups: ["workspace-1", "user-1"] },
        groupId: "user-1",
        modelName: "__sync_groups__",
      },
      ["user-1"]
    );
    await waitForAssertion(() => {
      expect(harness.socket.sent).toHaveLength(2);
    });
    expect(parseMessage(harness.socket.sent[1])).toMatchObject({
      packet: {
        actions: [
          {
            data: {
              subscribedSyncGroups: ["workspace-1", "workspace-3", "user-1"],
            },
          },
        ],
      },
      type: "delta",
    });

    // A client may ignore G. The active server session still cannot expand
    // until a fresh subscribe selects the newly granted group.
    harness.deltaSubscriber.emit(
      { ...createLiveAction("2"), groupId: "workspace-3" },
      ["workspace-3"]
    );
    await flush();
    expect(harness.socket.sent).toHaveLength(2);
  });

  it("closes fail-closed when a delivery policy revokes the credential", async () => {
    let accessAllowed = true;
    const authorizeAccess = vi
      .fn()
      .mockImplementation(({ groups }) =>
        Promise.resolve(accessAllowed ? { allowedGroups: groups } : false)
      );
    const harness = setup({
      authorizeAccess,
      deltaSubscriber: new MockDeltaSubscriber(),
      reauthorizeBeforeWebSocketDelivery: true,
      resolveGroups: vi.fn().mockResolvedValue(["workspace-1"]),
      verifyToken: vi
        .fn()
        .mockResolvedValue({ principal: { keyId: "key-1" }, userId: "user-1" }),
    });

    harness.socket.emit(
      "message",
      Buffer.from(JSON.stringify({ token: "tok", type: "subscribe" }))
    );
    await waitForAssertion(() => {
      expect(harness.socket.sent).toHaveLength(1);
    });

    accessAllowed = false;
    harness.deltaSubscriber.emit(
      { ...createLiveAction("1"), groupId: "workspace-1" },
      ["workspace-1"]
    );
    await waitForAssertion(() => {
      expect(harness.socket.closeCalls).toHaveLength(1);
    });

    expect(harness.socket.closeCalls[0]).toEqual({
      code: 4003,
      reason: "WebSocket delivery authorization failed",
    });
    expect(parseMessage(harness.socket.sent[1])).toEqual({
      code: "ACCESS_DENIED",
      message: "WebSocket delivery authorization failed",
      type: "error",
    });
    expect(harness.socket.sent).toHaveLength(2);
  });

  it("reauthorizes replay and buffered actions after a concurrent revocation", async () => {
    const replay = createDeferred<unknown[]>();
    let resolvedGroups = ["workspace-1", "workspace-2"];
    const harness = setup({
      deltaSubscriber: new MockDeltaSubscriber(),
      getSyncActions: vi.fn().mockImplementation(() => replay.promise),
      reauthorizeBeforeWebSocketDelivery: true,
      resolveGroups: vi
        .fn()
        .mockImplementation(() => Promise.resolve(resolvedGroups)),
    });

    harness.socket.emit(
      "message",
      Buffer.from(JSON.stringify({ token: "tok", type: "subscribe" }))
    );
    await waitForAssertion(() => {
      expect(harness.deltaSubscriber.callback).toBeTruthy();
    });

    harness.deltaSubscriber.emit(
      { ...createLiveAction("2"), groupId: "workspace-2" },
      ["workspace-2"]
    );
    resolvedGroups = ["workspace-1"];
    replay.resolve([{ ...createReplayAction(1n), groupId: "workspace-2" }]);

    await waitForAssertion(() => {
      expect(harness.socket.sent).toHaveLength(1);
    });
    expect(parseMessage(harness.socket.sent[0])).toEqual({
      afterSyncId: "0",
      groups: ["workspace-1", "user-1"],
      type: "subscribed",
    });
  });

  it("serializes protected live frame checks and sends in syncId order", async () => {
    const firstLiveDecision = createDeferred<{
      allowedGroups: readonly string[];
    }>();
    let policyCall = 0;
    const authorizeAccess = vi.fn().mockImplementation(async ({ groups }) => {
      policyCall += 1;
      if (policyCall === 3) {
        return await firstLiveDecision.promise;
      }
      return { allowedGroups: groups };
    });
    const harness = setup({
      authorizeAccess,
      deltaSubscriber: new MockDeltaSubscriber(),
      reauthorizeBeforeWebSocketDelivery: true,
      resolveGroups: vi.fn().mockResolvedValue(["workspace-1"]),
      verifyToken: vi
        .fn()
        .mockResolvedValue({ principal: { keyId: "key-1" }, userId: "user-1" }),
    });

    harness.socket.emit(
      "message",
      Buffer.from(JSON.stringify({ token: "tok", type: "subscribe" }))
    );
    await waitForAssertion(() => {
      expect(harness.socket.sent).toHaveLength(1);
    });

    harness.deltaSubscriber.emit(
      { ...createLiveAction("1"), groupId: "workspace-1" },
      ["workspace-1"]
    );
    harness.deltaSubscriber.emit(
      { ...createLiveAction("2"), groupId: "workspace-1" },
      ["workspace-1"]
    );
    await waitForAssertion(() => {
      expect(authorizeAccess).toHaveBeenCalledTimes(3);
    });
    expect(harness.socket.sent).toHaveLength(1);

    firstLiveDecision.resolve({
      allowedGroups: ["workspace-1", "user-1"],
    });
    await waitForAssertion(() => {
      expect(harness.socket.sent).toHaveLength(3);
    });
    const deliveredSyncIds = harness.socket.sent
      .slice(1)
      .map((frame) => parseMessage(frame))
      .map((frame) => (frame.packet as { lastSyncId: string }).lastSyncId);
    expect(deliveredSyncIds).toEqual(["1", "2"]);
  });

  it("forces bootstrap before a public frame can advance past a missed G action", async () => {
    vi.useFakeTimers();
    try {
      const deltaSubscriber = new MockDeltaSubscriber();
      const groupRefresh = {
        ...createReplayAction(1n),
        action: "G",
        data: { subscribedSyncGroups: ["workspace-1", "user-1"] },
        groupId: "user-1",
        model: "__sync_groups__",
        modelId: "user-1",
      };
      const harness = setup({
        deltaSubscriber,
        getLastSyncIdForGroups: vi.fn().mockResolvedValue(2n),
        getSyncGroupActions: vi.fn().mockResolvedValue([groupRefresh]),
        reauthorizeBeforeWebSocketDelivery: true,
        resolveGroups: vi.fn().mockResolvedValue(["workspace-1"]),
        webSocketGroupRefreshCatchUpIntervalMs: 100,
      });

      harness.socket.emit(
        "message",
        Buffer.from(JSON.stringify({ token: "tok", type: "subscribe" }))
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.socket.sent).toHaveLength(1);

      // Redis missed G/1, then delivered a public action with a later id. Even
      // an ungrouped frame would advance the reconnect cursor past G/1.
      deltaSubscriber.emit({ ...createLiveAction("2"), groupId: null }, []);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.socket.sent).toHaveLength(2);
      expect(parseMessage(harness.socket.sent[1])).toMatchObject({
        code: "BOOTSTRAP_REQUIRED",
        type: "error",
      });
      expect(harness.getSyncGroupActions).toHaveBeenCalledWith(
        0n,
        2n,
        "user-1",
        1
      );
      expect(harness.socket.closeCalls).toEqual([
        { code: 4009, reason: BOOTSTRAP_REQUIRED_WS_MESSAGE },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forces bootstrap when reconnect requests a group current auth rejects", async () => {
    const getSyncActions = vi.fn().mockResolvedValue([]);
    const harness = setup({
      getSyncActions,
      resolveGroups: vi.fn().mockResolvedValue(["workspace-current"]),
      webSocketGroupRefreshCatchUpIntervalMs: 100,
    });

    harness.socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          afterSyncId: "11",
          groups: ["workspace-revoked", "user-1"],
          token: "tok",
          type: "subscribe",
        })
      )
    );

    await waitForAssertion(() => {
      expect(harness.socket.sent).toHaveLength(1);
    });
    expect(parseMessage(harness.socket.sent[0])).toMatchObject({
      code: "BOOTSTRAP_REQUIRED",
      type: "error",
    });
    expect(getSyncActions).not.toHaveBeenCalled();
  });

  it("delivers a caught-up G action that advances the live cursor", async () => {
    vi.useFakeTimers();
    try {
      const groupRefresh = {
        ...createReplayAction(1n),
        action: "G",
        data: { subscribedSyncGroups: ["workspace-1", "user-1"] },
        groupId: "user-1",
        model: "__sync_groups__",
        modelId: "user-1",
      };
      const harness = setup({
        getLastSyncIdForGroups: vi.fn().mockResolvedValue(1n),
        getSyncGroupActions: vi.fn().mockResolvedValue([groupRefresh]),
        reauthorizeBeforeWebSocketDelivery: true,
        resolveGroups: vi.fn().mockResolvedValue(["workspace-1"]),
        webSocketGroupRefreshCatchUpIntervalMs: 100,
      });

      harness.socket.emit(
        "message",
        Buffer.from(JSON.stringify({ token: "tok", type: "subscribe" }))
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(100);

      expect(parseMessage(harness.socket.sent[1])).toMatchObject({
        packet: {
          actions: [{ action: "G", syncId: "1" }],
          lastSyncId: "1",
        },
        type: "delta",
      });
      expect(harness.socket.closeCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forces bootstrap when durable G catch-up falls behind retention", async () => {
    vi.useFakeTimers();
    try {
      const getEarliestSyncId = vi
        .fn()
        .mockResolvedValueOnce(0n)
        .mockResolvedValueOnce(10n);
      const harness = setup({
        getEarliestSyncId,
        getLastSyncIdForGroups: vi.fn().mockResolvedValue(10n),
        reauthorizeBeforeWebSocketDelivery: true,
        webSocketGroupRefreshCatchUpIntervalMs: 100,
      });

      harness.socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({ afterSyncId: "5", token: "tok", type: "subscribe" })
        )
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.socket.sent).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(harness.socket.closeCalls).toEqual([
        { code: 4009, reason: BOOTSTRAP_REQUIRED_WS_MESSAGE },
      ]);
      expect(parseMessage(harness.socket.sent[1])).toMatchObject({
        code: "BOOTSTRAP_REQUIRED",
        type: "error",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops live delivery to a revoked group without resubscribing", async () => {
    const deltaSubscriber = new MockDeltaSubscriber();
    const harness = setup({
      deltaSubscriber,
      resolveGroups: vi.fn().mockResolvedValue(["workspace-1", "workspace-2"]),
    });

    harness.socket.emit(
      "message",
      Buffer.from(JSON.stringify({ token: "tok", type: "subscribe" }))
    );
    await waitForAssertion(() => {
      expect(harness.socket.sent).toHaveLength(1);
    });

    deltaSubscriber.emit(
      {
        ...createLiveAction("1"),
        action: "G",
        data: { subscribedSyncGroups: ["workspace-1", "user-1"] },
        groupId: "user-1",
        modelName: "__sync_groups__",
      },
      ["user-1"]
    );
    deltaSubscriber.emit({ ...createLiveAction("2"), groupId: "workspace-2" }, [
      "workspace-2",
    ]);
    await flush();

    expect(harness.socket.sent).toHaveLength(2);
    expect(parseMessage(harness.socket.sent[1])).toMatchObject({
      packet: {
        actions: [
          {
            data: { subscribedSyncGroups: ["workspace-1", "user-1"] },
          },
        ],
      },
      type: "delta",
    });
  });

  it("shrinks buffered groups before delivering later revoked-group actions", async () => {
    const deferred = createDeferred<unknown[]>();
    const deltaSubscriber = new MockDeltaSubscriber();
    const harness = setup({
      authorizeAccess: vi.fn().mockResolvedValue({
        allowedGroups: ["workspace-1", "workspace-2", "user-1"],
      }),
      deltaSubscriber,
      getSyncActions: vi.fn().mockImplementation(() => deferred.promise),
      resolveGroups: vi.fn().mockResolvedValue(["workspace-1", "workspace-2"]),
      verifyToken: vi
        .fn()
        .mockResolvedValue({ principal: { keyId: "key-1" }, userId: "user-1" }),
    });

    harness.socket.emit(
      "message",
      Buffer.from(JSON.stringify({ token: "tok", type: "subscribe" }))
    );
    await waitForAssertion(() => {
      expect(deltaSubscriber.callback).toBeTruthy();
    });

    deltaSubscriber.emit(
      {
        ...createLiveAction("1"),
        action: "G",
        data: {
          subscribedSyncGroups: ["workspace-1", "workspace-3", "user-1"],
        },
        groupId: "user-1",
        modelName: "__sync_groups__",
      },
      ["user-1"]
    );
    deltaSubscriber.emit({ ...createLiveAction("2"), groupId: "workspace-2" }, [
      "workspace-2",
    ]);
    deltaSubscriber.emit({ ...createLiveAction("3"), groupId: "workspace-3" }, [
      "workspace-3",
    ]);
    deferred.resolve([]);

    await waitForAssertion(() => {
      expect(harness.socket.sent).toHaveLength(2);
    });
    expect(parseMessage(harness.socket.sent[0])).toMatchObject({
      packet: {
        actions: [
          {
            data: { subscribedSyncGroups: ["workspace-1", "user-1"] },
          },
        ],
      },
      type: "delta",
    });
    expect(parseMessage(harness.socket.sent[1])).toMatchObject({
      groups: ["workspace-1", "user-1"],
      type: "subscribed",
    });
  });

  it("filters replay actions after a durable group revocation", async () => {
    const groupRefresh = {
      ...createReplayAction(1n),
      action: "G",
      data: { subscribedSyncGroups: ["workspace-1", "user-1"] },
      groupId: "user-1",
      model: "__sync_groups__",
      modelId: "user-1",
    };
    const revokedAction = {
      ...createReplayAction(2n),
      groupId: "workspace-2",
      modelId: "revoked-task",
    };
    const harness = setup({
      getSyncActions: vi
        .fn()
        .mockResolvedValueOnce([groupRefresh, revokedAction])
        .mockResolvedValueOnce([]),
      resolveGroups: vi.fn().mockResolvedValue(["workspace-1", "workspace-2"]),
    });

    harness.socket.emit(
      "message",
      Buffer.from(JSON.stringify({ token: "tok", type: "subscribe" }))
    );

    await waitForAssertion(() => {
      expect(harness.socket.sent).toHaveLength(2);
    });
    const deliveredActions = harness.socket.sent.flatMap((frame) => {
      const message = parseMessage(frame);
      return message.type === "delta"
        ? ((message.packet as { actions: unknown[] }).actions ?? [])
        : [];
    });
    expect(deliveredActions).toHaveLength(1);
    expect(deliveredActions[0]).toMatchObject({
      action: "G",
      data: { subscribedSyncGroups: ["workspace-1", "user-1"] },
    });
    expect(parseMessage(harness.socket.sent[1])).toMatchObject({
      groups: ["workspace-1", "user-1"],
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

  it("stops the heartbeat timer on close (no timer leak)", async () => {
    vi.useFakeTimers();

    try {
      const harness = setup();
      harness.socket.close();

      await vi.advanceTimersByTimeAsync(120_000);

      // No pings should fire after the socket is closed.
      expect(harness.socket.pingCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not leak the bus subscription when the socket closes mid-replay", async () => {
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

    // The subscription is installed before replay begins.
    await waitForAssertion(() => {
      expect(deltaSubscriber.callback).toBeTruthy();
    });

    // Socket disconnects while replay is still awaiting the DB.
    harness.socket.close();
    deferred.resolve([]);
    await flush();

    // close() must have torn the bus subscription down.
    expect(deltaSubscriber.callback).toBeNull();
    expect(
      harness.socket.sent.some(
        (message) => parseMessage(message).type === "subscribed"
      )
    ).toBeFalsy();
  });

  it("flushes buffered live deltas in ascending syncId order, deduped", async () => {
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

    // Arrive out of order, with a duplicate syncId (first-wins).
    deltaSubscriber.emit(createLiveAction("3"), []);
    deltaSubscriber.emit(createLiveAction("1"), []);
    deltaSubscriber.emit(createLiveAction("2"), []);
    deltaSubscriber.emit(createLiveAction("2"), []);

    deferred.resolve([]);

    await waitForAssertion(() => {
      expect(
        harness.socket.sent.some(
          (message) => parseMessage(message).type === "subscribed"
        )
      ).toBeTruthy();
    });

    const deltaSyncIds = harness.socket.sent
      .map((message) => parseMessage(message))
      .filter((message) => message.type === "delta")
      .map((message) => (message.packet as { lastSyncId: string }).lastSyncId);

    expect(deltaSyncIds).toEqual(["1", "2", "3"]);
  });

  it("pages replay in 1000-row batches", async () => {
    const firstPage = Array.from({ length: 1000 }, (_unused, index) =>
      createReplayAction(BigInt(index + 1))
    );
    const getSyncActions = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([createReplayAction(1001n)]);

    const harness = setup({ getSyncActions });

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
      expect(
        harness.socket.sent.some(
          (message) => parseMessage(message).type === "subscribed"
        )
      ).toBeTruthy();
    });

    // A full page (1000) triggers a second fetch; a short page stops paging.
    expect(getSyncActions).toHaveBeenCalledTimes(2);
    const deltaCount = harness.socket.sent.filter(
      (message) => parseMessage(message).type === "delta"
    ).length;
    expect(deltaCount).toBe(1001);
  });
});
