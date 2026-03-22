import { GraphQLTransportAdapter } from "../src/adapter";
import type { TransportOptions } from "../src/types";
import { YjsTransportAdapter } from "../src/yjs-transport";

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
  sent: string[] = [];

  private readonly listeners = new Map<
    string,
    Set<EventListenerOrEventListenerObject>
  >();

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
    if (!eventListeners) {
      return true;
    }

    for (const listener of eventListeners) {
      if (typeof listener === "function") {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    }
    return true;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
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
}

const lastSocket = (): MockWebSocket => {
  const socket = instances.at(-1);
  if (!socket) {
    throw new Error("No MockWebSocket created yet");
  }
  return socket;
};

const flush = async (): Promise<void> => {
  // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
};

const createTransport = (): GraphQLTransportAdapter => {
  const options: TransportOptions = {
    auth: {
      getAccessToken: () => "token",
    },
    endpoint: "https://example.com/graphql",
    syncEndpoint: "https://example.com/sync",
    webSocketFactory: MockWebSocket as unknown as typeof WebSocket,
    wsEndpoint: "wss://example.com/ws",
  };

  return new GraphQLTransportAdapter(options);
};

afterEach(() => {
  instances.length = 0;
  vi.restoreAllMocks();
});

describe(YjsTransportAdapter, () => {
  it("reports connection state and forwards state changes", () => {
    const send = vi.fn();
    const adapter = new YjsTransportAdapter(send, "disconnected");
    const states: string[] = [];

    adapter.onConnectionStateChange((state) => {
      states.push(state);
    });

    expect(adapter.isConnected()).toBeFalsy();

    adapter.handleConnectionStateChange("connecting");
    adapter.handleConnectionStateChange("connected");
    adapter.handleConnectionStateChange("connected");

    expect(states).toEqual(["disconnected", "connecting", "connected"]);
    expect(adapter.isConnected()).toBeTruthy();
  });
});

describe(GraphQLTransportAdapter, () => {
  it("opens a single websocket for one subscribe call", async () => {
    const transport = createTransport();
    const subscription = transport.subscribe({ afterSyncId: "0" });

    await flush();

    expect(instances).toHaveLength(1);

    subscription.unsubscribe();
    await transport.close();
  });

  it("forwards websocket connection state changes to yjs transport", async () => {
    const transport = createTransport();
    const yjsTransport = transport.getYjsTransport();
    const states: string[] = [];

    yjsTransport.onConnectionStateChange((state) => {
      states.push(state);
    });

    expect(yjsTransport.isConnected()).toBeFalsy();
    expect(states).toEqual(["disconnected"]);

    yjsTransport.send({
      clientId: "client-1",
      connId: "conn-1",
      entityId: "task-1",
      entityType: "Task",
      fieldName: "description",
      state: "start",
      type: "doc_view",
    });

    await flush();
    expect(states).toContain("connecting");

    lastSocket().simulateOpen();
    await flush();

    expect(yjsTransport.isConnected()).toBeFalsy();
    expect(states.at(-1)).toBe("connecting");

    lastSocket().simulateMessage(
      JSON.stringify({ afterSyncId: "0", groups: [], type: "subscribed" })
    );
    await flush();

    expect(yjsTransport.isConnected()).toBeTruthy();
    expect(states.at(-1)).toBe("connected");

    lastSocket().simulateClose();
    await flush();

    expect(yjsTransport.isConnected()).toBeFalsy();
    expect(states.at(-1)).toBe("disconnected");

    await transport.close();
  });

  it("buffers outbound yjs messages until subscribed ack", async () => {
    const transport = createTransport();
    const yjsTransport = transport.getYjsTransport();
    const subscription = transport.subscribe({ afterSyncId: "0" });

    yjsTransport.send({
      clientId: "client-1",
      connId: "conn-1",
      entityId: "task-1",
      entityType: "Task",
      fieldName: "description",
      state: "start",
      type: "doc_view",
    });

    await flush();
    lastSocket().simulateOpen();
    await flush();

    const beforeAckMessages = lastSocket().sent.filter((sent) =>
      sent.includes('"type":"doc_view"')
    );
    expect(beforeAckMessages).toHaveLength(0);

    lastSocket().simulateMessage(
      JSON.stringify({ afterSyncId: "0", groups: [], type: "subscribed" })
    );
    await flush();

    const afterAckMessages = lastSocket().sent.filter((sent) =>
      sent.includes('"type":"doc_view"')
    );
    expect(afterAckMessages).toHaveLength(1);

    subscription.unsubscribe();
    await transport.close();
  });
});
