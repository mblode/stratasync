import type { AuthProvider, RetryConfig } from "../src/types";
import { WebSocketManager } from "../src/websocket";

const instances: MockWebSocket[] = [];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url: string;
  protocol = "";
  bufferedAmount = 0;
  extensions = "";
  binaryType: BinaryType = "blob";

  private readonly listeners = new Map<
    string,
    Set<EventListenerOrEventListenerObject>
  >();

  sent: string[] = [];
  sendFailuresRemaining = 0;
  closed = false;

  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(url: string | URL, _protocols?: string | string[]) {
    this.url = typeof url === "string" ? url : url.toString();
    instances.push(this);
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject
  ): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    const eventListeners = this.listeners.get(event.type);
    if (eventListeners) {
      for (const listener of eventListeners) {
        if (typeof listener === "function") {
          listener(event);
        } else {
          listener.handleEvent(event);
        }
      }
    }
    return true;
  }

  send(data: string): void {
    if (this.sendFailuresRemaining > 0) {
      this.sendFailuresRemaining -= 1;
      throw new Error("Mock send failure");
    }
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  simulateMessage(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  simulateError(): void {
    this.dispatchEvent(new Event("error"));
  }
}

const lastSocket = (): MockWebSocket => {
  const socket = instances.at(-1);
  if (!socket) {
    throw new Error("No MockWebSocket created yet");
  }
  return socket;
};

/**
 * Flushes microtasks so that async connect() progresses past resolveAuthToken
 */
const flush = async (): Promise<void> => {
  // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
};

const retryConfig: RetryConfig = {
  baseDelay: 10,
  maxDelay: 100,
  maxRetries: 3,
};

const createAuth = (token: string | null): AuthProvider => ({
  getAccessToken: () => token,
});

const createManager = (
  auth: AuthProvider = createAuth("tok")
): WebSocketManager =>
  new WebSocketManager(
    "wss://example.com/ws",
    auth,
    retryConfig,
    MockWebSocket as unknown as typeof WebSocket
  );

afterEach(() => {
  instances.length = 0;
  vi.restoreAllMocks();
});

describe(WebSocketManager, () => {
  it("connects with auth token in URL", async () => {
    const manager = createManager(createAuth("my-token"));

    const connectPromise = manager.connect();
    await flush();
    lastSocket().simulateOpen();
    await connectPromise;

    expect(lastSocket().url).toContain("token=my-token");
    await manager.close();
  });

  it("connects without token when auth returns null", async () => {
    const manager = createManager(createAuth(null));

    const connectPromise = manager.connect();
    await flush();
    lastSocket().simulateOpen();
    await connectPromise;

    expect(lastSocket().url).toBe("wss://example.com/ws");
    await manager.close();
  });

  it("falls back to refreshToken when getAccessToken returns null", async () => {
    const auth: AuthProvider = {
      getAccessToken: () => null,
      refreshToken: () => "refreshed",
    };

    const manager = createManager(auth);

    const connectPromise = manager.connect();
    await flush();
    lastSocket().simulateOpen();
    await connectPromise;

    expect(lastSocket().url).toContain("token=refreshed");
    await manager.close();
  });

  it("retries subscribe until a token becomes available", async () => {
    let token: string | null = null;
    const manager = createManager({
      getAccessToken: () => token,
    });

    const connectPromise = manager.connect();
    await flush();
    const socket = lastSocket();
    socket.simulateOpen();
    await connectPromise;

    const subscription = manager.subscribe({ afterSyncId: "0" });
    await flush();
    expect(socket.sent).toHaveLength(0);

    token = "late-token";
    // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
    await new Promise((resolve) => {
      setTimeout(resolve, retryConfig.baseDelay + 20);
    });
    await flush();

    const subscribeMessages = socket.sent.filter((message) =>
      message.includes('"type":"subscribe"')
    );
    expect(subscribeMessages).toHaveLength(1);
    expect(subscribeMessages[0]).toContain('"token":"late-token"');

    subscription.unsubscribe();
    await manager.close();
  });

  it("uses refreshToken fallback for subscribe sends", async () => {
    const manager = createManager({
      getAccessToken: () => null,
      refreshToken: () => "subscribe-refresh-token",
    });

    const connectPromise = manager.connect();
    await flush();
    const socket = lastSocket();
    socket.simulateOpen();
    await connectPromise;

    const subscription = manager.subscribe({ afterSyncId: "0" });
    await flush();

    const subscribeMessages = socket.sent.filter((message) =>
      message.includes('"type":"subscribe"')
    );
    expect(subscribeMessages).toHaveLength(1);
    expect(subscribeMessages[0]).toContain('"token":"subscribe-refresh-token"');

    subscription.unsubscribe();
    await manager.close();
  });

  it("includes requested groups in subscribe messages", async () => {
    const manager = createManager();

    const connectPromise = manager.connect();
    await flush();
    const socket = lastSocket();
    socket.simulateOpen();
    await connectPromise;

    const subscription = manager.subscribe({
      afterSyncId: "12",
      groups: ["team-1", "team-2"],
    });
    await flush();

    const subscribeMessages = socket.sent.filter((message) =>
      message.includes('"type":"subscribe"')
    );
    expect(subscribeMessages).toHaveLength(1);
    expect(subscribeMessages[0]).toContain('"afterSyncId":"12"');
    expect(subscribeMessages[0]).toContain('"groups":["team-1","team-2"]');

    subscription.unsubscribe();
    await manager.close();
  });

  it("stops subscribe retries when closed before retry fires", async () => {
    const manager = createManager({
      getAccessToken: () => null,
    });

    const connectPromise = manager.connect();
    await flush();
    const socket = lastSocket();
    socket.simulateOpen();
    await connectPromise;

    const subscription = manager.subscribe({ afterSyncId: "0" });
    await flush();

    await manager.close();
    // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
    await new Promise((resolve) => {
      setTimeout(resolve, retryConfig.baseDelay * 2);
    });
    await flush();

    expect(instances).toHaveLength(1);
    expect(socket.sent).toHaveLength(0);

    subscription.unsubscribe();
  });

  it("limits subscribe retries and transitions to error", async () => {
    const manager = createManager({
      getAccessToken: () => null,
    });
    const states: string[] = [];
    manager.onConnectionStateChange((state) => {
      states.push(state);
    });

    const connectPromise = manager.connect();
    await flush();
    const socket = lastSocket();
    socket.simulateOpen();
    await connectPromise;

    const subscription = manager.subscribe({ afterSyncId: "0" });
    await flush();

    // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
    await new Promise((resolve) => {
      setTimeout(resolve, 140);
    });
    await flush();

    expect(states).toContain("error");
    expect(socket.sent).toHaveLength(0);

    subscription.unsubscribe();
    await manager.close();
  });

  it("keeps retrying subscribe after error and recovers without re-subscribing", async () => {
    let token: string | null = null;
    const manager = createManager({
      getAccessToken: () => token,
    });

    const connectPromise = manager.connect();
    await flush();
    const socket = lastSocket();
    socket.simulateOpen();
    await connectPromise;

    const subscription = manager.subscribe({ afterSyncId: "0" });
    await flush();

    // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
    await new Promise((resolve) => {
      setTimeout(resolve, 140);
    });
    await flush();
    expect(manager.getConnectionState()).toBe("error");

    token = "recovered-token";
    // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
    await new Promise((resolve) => {
      setTimeout(resolve, 220);
    });
    await flush();

    const subscribeMessages = socket.sent.filter((message) =>
      message.includes('"type":"subscribe"')
    );
    expect(subscribeMessages.length).toBeGreaterThan(0);
    expect(subscribeMessages.at(-1)).toContain('"token":"recovered-token"');

    socket.simulateMessage(
      JSON.stringify({ afterSyncId: "0", groups: [], type: "subscribed" })
    );
    await flush();

    expect(manager.getConnectionState()).toBe("connected");

    subscription.unsubscribe();
    await manager.close();
  });

  it("returns to connected after subscribe recovers from error", async () => {
    let token: string | null = null;
    const manager = createManager({
      getAccessToken: () => token,
    });
    const states: string[] = [];
    manager.onConnectionStateChange((state) => {
      states.push(state);
    });

    const connectPromise = manager.connect();
    await flush();
    const socket = lastSocket();
    socket.simulateOpen();
    await connectPromise;

    const initialSubscription = manager.subscribe({ afterSyncId: "0" });
    await flush();

    // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
    await new Promise((resolve) => {
      setTimeout(resolve, 140);
    });
    await flush();
    expect(manager.getConnectionState()).toBe("error");

    token = "recovered-token";
    const recoverySubscription = manager.subscribe({ afterSyncId: "0" });
    await flush();

    const subscribeMessages = socket.sent.filter((message) =>
      message.includes('"type":"subscribe"')
    );
    expect(subscribeMessages.at(-1)).toContain('"token":"recovered-token"');

    socket.simulateMessage(
      JSON.stringify({ afterSyncId: "0", groups: [], type: "subscribed" })
    );
    await flush();

    expect(manager.getConnectionState()).toBe("connected");
    expect(states).toContain("connected");

    initialSubscription.unsubscribe();
    recoverySubscription.unsubscribe();
    await manager.close();
  });

  it("treats server subscribe error messages as connection errors and retries subscribe", async () => {
    const manager = createManager();
    const states: string[] = [];
    manager.onConnectionStateChange((state) => {
      states.push(state);
    });

    const connectPromise = manager.connect();
    await flush();
    const socket = lastSocket();
    socket.simulateOpen();
    await connectPromise;

    const subscription = manager.subscribe({ afterSyncId: "0" });
    await flush();

    const initialSubscribeCount = socket.sent.filter((message) =>
      message.includes('"type":"subscribe"')
    ).length;
    expect(initialSubscribeCount).toBeGreaterThan(0);

    socket.simulateMessage(
      JSON.stringify({ message: "Invalid token", type: "error" })
    );
    await flush();
    expect(manager.getConnectionState()).toBe("error");

    // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
    await new Promise((resolve) => {
      setTimeout(resolve, retryConfig.baseDelay + 20);
    });
    await flush();

    const retriedSubscribeCount = socket.sent.filter((message) =>
      message.includes('"type":"subscribe"')
    ).length;
    expect(retriedSubscribeCount).toBeGreaterThan(initialSubscribeCount);
    expect(states).toContain("error");

    socket.simulateMessage(
      JSON.stringify({ afterSyncId: "0", groups: [], type: "subscribed" })
    );
    await flush();
    expect(manager.getConnectionState()).toBe("connected");

    subscription.unsubscribe();
    await manager.close();
  });

  it("tracks connection state changes", async () => {
    const manager = createManager();

    const states: string[] = [];
    manager.onConnectionStateChange((state) => {
      states.push(state);
    });

    expect(manager.getConnectionState()).toBe("disconnected");

    const connectPromise = manager.connect();
    // "connecting" fires synchronously before the await
    expect(states).toContain("connecting");

    await flush();
    lastSocket().simulateOpen();
    await connectPromise;
    expect(states).toContain("connected");

    await manager.close();
    expect(states).toContain("disconnected");
  });

  it("deduplicates concurrent connect calls while auth is resolving", async () => {
    let resolveToken: ((token: string | null) => void) | null = null;
    const manager = createManager({
      getAccessToken: () =>
        // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
        new Promise<string | null>((resolve) => {
          resolveToken = resolve;
        }),
    });

    const connectA = manager.connect();
    const connectB = manager.connect();

    expect(instances).toHaveLength(0);
    expect(resolveToken).not.toBeNull();

    if (resolveToken) {
      resolveToken("tok");
    }
    await Promise.all([connectA, connectB]);

    expect(instances).toHaveLength(1);

    await manager.close();
  });

  it("queues messages when disconnected and flushes after subscribed ack", async () => {
    const manager = createManager();

    manager.sendRaw(JSON.stringify({ type: "ping" }));

    // sendRaw triggers connect() which is async
    await flush();
    expect(instances.length).toBeGreaterThan(0);
    expect(lastSocket().sent).toHaveLength(0);

    lastSocket().simulateOpen();

    // Wait for flush
    await flush();

    expect(lastSocket().sent).toHaveLength(0);

    lastSocket().simulateMessage(
      JSON.stringify({ afterSyncId: "0", groups: [], type: "subscribed" })
    );
    await flush();

    expect(lastSocket().sent).toHaveLength(1);
    expect(lastSocket().sent[0]).toContain("ping");

    await manager.close();
  });

  it("sends immediately when already connected", async () => {
    const manager = createManager();

    const connectPromise = manager.connect();
    await flush();
    lastSocket().simulateOpen();
    await connectPromise;

    lastSocket().simulateMessage(
      JSON.stringify({ afterSyncId: "0", groups: [], type: "subscribed" })
    );
    await flush();

    manager.sendRaw(JSON.stringify({ type: "ping" }));
    expect(lastSocket().sent).toContain('{"type":"ping"}');

    await manager.close();
  });

  it("retains queued messages when flush send fails and retries on reconnect", async () => {
    const manager = createManager();
    const subscription = manager.subscribe({ afterSyncId: "0" });
    manager.sendRaw(JSON.stringify({ type: "ping" }));

    await flush();
    const firstSocket = lastSocket();
    firstSocket.simulateOpen();
    await flush();

    firstSocket.sendFailuresRemaining = 1;
    firstSocket.simulateMessage(
      JSON.stringify({ afterSyncId: "0", groups: [], type: "subscribed" })
    );
    await flush();

    const firstSocketPings = firstSocket.sent.filter((sent) =>
      sent.includes('"type":"ping"')
    );
    expect(firstSocketPings).toHaveLength(0);

    firstSocket.simulateClose();
    // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
    await new Promise((resolve) => {
      setTimeout(resolve, retryConfig.baseDelay + 5);
    });
    await flush();

    const secondSocket = lastSocket();
    expect(secondSocket).not.toBe(firstSocket);
    secondSocket.simulateOpen();
    await flush();

    secondSocket.simulateMessage(
      JSON.stringify({ afterSyncId: "0", groups: [], type: "subscribed" })
    );
    await flush();

    const secondSocketPings = secondSocket.sent.filter((sent) =>
      sent.includes('"type":"ping"')
    );
    expect(secondSocketPings).toHaveLength(1);

    subscription.unsubscribe();
    await manager.close();
  });

  it("close stops reconnect and closes socket", async () => {
    const manager = createManager();

    const connectPromise = manager.connect();
    await flush();
    lastSocket().simulateOpen();
    await connectPromise;

    await manager.close();

    expect(lastSocket().closed).toBeTruthy();
    expect(manager.getConnectionState()).toBe("disconnected");
  });

  it("reports error state on WebSocket error", async () => {
    const manager = createManager();

    const states: string[] = [];
    manager.onConnectionStateChange((state) => {
      states.push(state);
    });

    const connectPromise = manager.connect();
    await flush();
    lastSocket().simulateError();
    lastSocket().simulateOpen();
    await connectPromise;

    expect(states).toContain("error");

    await manager.close();
  });

  it("subscribe returns async iterable that yields delta packets", async () => {
    const manager = createManager();

    const connectPromise = manager.connect();
    await flush();
    lastSocket().simulateOpen();
    await connectPromise;

    const subscription = manager.subscribe({ afterSyncId: "0" });

    // Wait for subscribe message to be sent
    await flush();

    // Simulate a delta packet message
    lastSocket().simulateMessage(
      JSON.stringify({
        actions: [
          {
            action: "I",
            data: {},
            id: "5",
            modelId: "i1",
            modelName: "Task",
          },
        ],
        lastSyncId: "5",
      })
    );

    // Wait for async message handling
    await flush();

    const iterator = subscription[Symbol.asyncIterator]();
    const result = await Promise.race([
      iterator.next(),
      // oxlint-disable-next-line avoid-new, param-names -- wrapping callback API in promise; only reject used
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("timeout"));
        }, 1000);
      }),
    ]);

    expect(result.done).toBeFalsy();
    expect(result.value.lastSyncId).toBe("5");
    expect(result.value.actions).toHaveLength(1);

    subscription.unsubscribe();
    await manager.close();
  });

  it("rejects numeric subscribe sync IDs before sending", async () => {
    const manager = createManager();
    const connectPromise = manager.connect();
    await flush();
    lastSocket().simulateOpen();
    await connectPromise;

    expect(() =>
      manager.subscribe({ afterSyncId: 5 as unknown as string })
    ).not.toThrow();

    await flush();

    expect(lastSocket().sent).toHaveLength(0);
    expect(manager.getConnectionState()).toBe("error");

    await manager.close();
  });

  it("routes live editing messages to yjs callbacks, not subscriptions", async () => {
    const manager = createManager();

    const connectPromise = manager.connect();
    await flush();
    lastSocket().simulateOpen();
    await connectPromise;

    const yjsMessages: unknown[] = [];
    manager.onYjsMessage((msg) => yjsMessages.push(msg));

    const subscription = manager.subscribe({ afterSyncId: "0" });

    await flush();

    lastSocket().simulateMessage(
      JSON.stringify({ data: [1, 2, 3], type: "yjs_update" })
    );

    await flush();

    expect(yjsMessages).toHaveLength(1);
    expect((yjsMessages[0] as Record<string, unknown>).type).toBe("yjs_update");

    subscription.unsubscribe();
    await manager.close();
  });

  it("unsubscribe callback removes listener", async () => {
    const manager = createManager();

    const states: string[] = [];
    const unsubscribe = manager.onConnectionStateChange((state) => {
      states.push(state);
    });

    unsubscribe();

    const connectPromise = manager.connect();
    await flush();
    lastSocket().simulateOpen();
    await connectPromise;

    // No states recorded since we unsubscribed
    expect(states).toHaveLength(0);

    await manager.close();
  });
});
