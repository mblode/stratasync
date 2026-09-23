/**
 * Lifecycle races in WebSocketManager found by the Lean model in
 * verification/lean/StrataSync/Orchestrator.lean (see `bug_ws_*`).
 */
import type { RetryConfig } from "../src/types";
import { WebSocketManager } from "../src/websocket";

const instances: MockWebSocket[] = [];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  readonly url: string;
  readonly sent: string[] = [];
  closeCalled = false;

  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(url: string | URL) {
    this.url = typeof url === "string" ? url : url.toString();
    instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  private dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new Event(type));
    }
  }

  send(data: string): void {
    this.sent.push(data);
  }

  /** Like a real socket: close() starts the handshake; the event comes later. */
  close(): void {
    this.closeCalled = true;
    this.readyState = MockWebSocket.CLOSING;
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.dispatch("open");
  }

  /** The asynchronous `close` event that follows `close()`. */
  simulateCloseEvent(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatch("close");
  }

  simulateErrorEvent(): void {
    this.dispatch("error");
  }
}

const flush = async (): Promise<void> => {
  // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
};

const retryConfig: RetryConfig = { baseDelay: 5, maxDelay: 10, maxRetries: 3 };

const liveSockets = (): MockWebSocket[] =>
  instances.filter((socket) => !socket.closeCalled);

const managers: WebSocketManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await manager.close();
  }
  instances.length = 0;
});

describe("WebSocketManager lifecycle", () => {
  it("ignores the late close event of a socket it already replaced", async () => {
    const manager = new WebSocketManager(
      "wss://example.com/ws",
      { getAccessToken: () => "tok" },
      retryConfig,
      MockWebSocket as unknown as typeof WebSocket
    );
    managers.push(manager);
    const states: string[] = [];
    manager.onConnectionStateChange((state) => states.push(state));

    // Run 1: subscribe + open socket A.
    manager.subscribe({ afterSyncId: "0" });
    await flush();
    const [socketA] = instances;
    socketA?.simulateOpen();

    // stop(): close() starts A's closing handshake.
    await manager.close();

    // start() again: a fresh subscription opens socket B.
    manager.subscribe({ afterSyncId: "0" });
    await flush();
    const [, socketB] = instances;
    socketB?.simulateOpen();
    expect(manager.getConnectionState()).toBe("connected");

    // A's close event finally arrives. It belongs to a socket the manager
    // no longer owns and must not touch B's state.
    socketA?.simulateErrorEvent();
    socketA?.simulateCloseEvent();
    expect(manager.getConnectionState()).toBe("connected");

    // Nor may it schedule a reconnect that opens a second live socket.
    // oxlint-disable-next-line avoid-new -- wait past the reconnect backoff
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    await flush();
    expect(liveSockets()).toHaveLength(1);
    expect(liveSockets()[0]).toBe(socketB);

    await manager.close();
  });

  it("connects after a close() that interrupted an in-flight connect", async () => {
    let releaseToken: ((token: string) => void) | null = null;
    let calls = 0;
    const manager = new WebSocketManager(
      "wss://example.com/ws",
      {
        getAccessToken: () => {
          calls += 1;
          if (calls === 1) {
            // oxlint-disable-next-line avoid-new -- hold the first auth lookup open
            return new Promise<string>((resolve) => {
              releaseToken = resolve;
            });
          }
          return "tok";
        },
      },
      retryConfig,
      MockWebSocket as unknown as typeof WebSocket
    );
    managers.push(manager);

    // Run 1 subscribes; connect() is waiting on the auth provider.
    manager.subscribe({ afterSyncId: "0" });
    await flush();
    expect(instances).toHaveLength(0);

    // stop() + start() while auth is still pending.
    await manager.close();
    const subscription = manager.subscribe({ afterSyncId: "0" });
    await flush();

    // The first auth lookup finally resolves.
    (releaseToken as ((token: string) => void) | null)?.("tok");
    await flush();
    await flush();

    // The live subscription must get a socket.
    expect(liveSockets()).toHaveLength(1);

    subscription.unsubscribe();
    await manager.close();
  });

  it("ignores an auth failure from a connect attempt close() orphaned", async () => {
    let failToken: ((error: Error) => void) | null = null;
    let calls = 0;
    const manager = new WebSocketManager(
      "wss://example.com/ws",
      {
        getAccessToken: () => {
          calls += 1;
          if (calls === 1) {
            // oxlint-disable-next-line avoid-new -- hold the first auth lookup open
            return new Promise<string>((_resolve, reject) => {
              failToken = reject;
            });
          }
          return "tok";
        },
      },
      retryConfig,
      MockWebSocket as unknown as typeof WebSocket
    );
    managers.push(manager);

    // Run 1 subscribes; its connect() is waiting on the auth provider.
    manager.subscribe({ afterSyncId: "0" });
    await flush();

    // stop() + start(): run 2 connects and its socket opens.
    await manager.close();
    manager.subscribe({ afterSyncId: "0" });
    await flush();
    const [socketB] = instances;
    socketB?.simulateOpen();
    expect(manager.getConnectionState()).toBe("connected");

    // Run 1's orphaned auth lookup now fails. It belongs to a generation
    // close() already retired and must not report an error on run 2's socket.
    (failToken as ((error: Error) => void) | null)?.(new Error("auth down"));
    await flush();
    await flush();

    expect(manager.getConnectionState()).toBe("connected");
    expect(liveSockets()).toEqual([socketB]);

    await manager.close();
  });
});
