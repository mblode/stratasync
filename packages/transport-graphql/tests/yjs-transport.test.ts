import {
  createInsertTransaction,
  createTransactionBatch,
} from "@stratasync/core";

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

  it("rejects sends after disposal", () => {
    const send = vi.fn();
    const adapter = new YjsTransportAdapter(send, "connected");

    adapter.dispose();

    expect(() =>
      adapter.send({
        clientId: "client-1",
        connId: "conn-1",
        entityId: "task-1",
        entityType: "Task",
        fieldName: "description",
        state: "start",
        type: "doc_view",
      })
    ).toThrow("Yjs transport is closed");
    expect(send).not.toHaveBeenCalled();
  });
});

describe(GraphQLTransportAdapter, () => {
  it("normalizes sync endpoints before posting REST mutations", async () => {
    const tx = createInsertTransaction("client-1", "Task", "task-1", {
      title: "Test",
    });
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        lastSyncId: "1",
        results: [{ clientTxId: tx.clientTxId, success: true, syncId: "1" }],
        success: true,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const transport = new GraphQLTransportAdapter({
      auth: {
        getAccessToken: () => "token",
      },
      endpoint: "https://example.com/graphql",
      syncEndpoint: "https://example.com/sync/mutate",
      webSocketFactory: MockWebSocket as unknown as typeof WebSocket,
      wsEndpoint: "wss://example.com/ws",
    });

    await transport.mutate(createTransactionBatch([tx]));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://example.com/sync/mutate"
    );

    await transport.close();
  });

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

  it("drops adapter connection listeners on close", async () => {
    const transport = createTransport();
    const states: string[] = [];

    transport.onConnectionStateChange((state) => {
      states.push(state);
    });

    const subscription = transport.subscribe({ afterSyncId: "0" });
    await flush();
    await transport.close();

    const restartedSubscription = transport.subscribe({ afterSyncId: "1" });
    await flush();
    lastSocket().simulateOpen();
    await flush();

    expect(states).toEqual(["connecting", "disconnected"]);

    subscription.unsubscribe();
    restartedSubscription.unsubscribe();
    await transport.close();
  });

  it("detaches the old yjs transport listener on close", async () => {
    const transport = createTransport();
    const firstTransport = transport.getYjsTransport();
    const firstMessages: unknown[] = [];
    firstTransport.onMessage((message) => {
      firstMessages.push(message);
    });

    firstTransport.send({
      clientId: "client-1",
      connId: "conn-1",
      entityId: "task-1",
      entityType: "Task",
      fieldName: "description",
      state: "start",
      type: "doc_view",
    });
    await flush();

    await transport.close();

    const secondTransport = transport.getYjsTransport();
    const secondMessages: unknown[] = [];
    secondTransport.onMessage((message) => {
      secondMessages.push(message);
    });
    expect(secondTransport).not.toBe(firstTransport);

    secondTransport.send({
      clientId: "client-2",
      connId: "conn-2",
      entityId: "task-2",
      entityType: "Task",
      fieldName: "description",
      state: "start",
      type: "doc_view",
    });
    await flush();
    lastSocket().simulateOpen();
    await flush();

    lastSocket().simulateMessage(
      JSON.stringify({
        clientId: "client-2",
        connId: "conn-2",
        entityId: "task-2",
        entityType: "Task",
        fieldName: "description",
        payload: "AQID",
        seq: 1,
        type: "yjs_update",
      })
    );
    await flush();

    expect(firstMessages).toEqual([]);
    expect(secondMessages).toHaveLength(1);

    await transport.close();
  });

  it("rejects sends from stale yjs transport handles after close", async () => {
    const transport = createTransport();
    const firstTransport = transport.getYjsTransport();

    firstTransport.send({
      clientId: "client-1",
      connId: "conn-1",
      entityId: "task-1",
      entityType: "Task",
      fieldName: "description",
      state: "start",
      type: "doc_view",
    });
    await flush();

    expect(instances).toHaveLength(1);

    await transport.close();

    expect(() =>
      firstTransport.send({
        clientId: "client-1",
        connId: "conn-1",
        entityId: "task-1",
        entityType: "Task",
        fieldName: "description",
        state: "start",
        type: "doc_view",
      })
    ).toThrow("Yjs transport is closed");
    expect(instances).toHaveLength(1);
  });
});
