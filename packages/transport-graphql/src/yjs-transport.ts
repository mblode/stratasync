import type {
  ClientMessage,
  ServerMessage,
  YjsTransport,
  YjsTransportConnectionState,
} from "@stratasync/y-doc";

/**
 * Adapter that wires Yjs transport messages into the GraphQL WebSocket manager.
 */
export class YjsTransportAdapter implements YjsTransport {
  private readonly sendFn: (message: ClientMessage) => void;
  private readonly callbacks = new Set<(message: ServerMessage) => void>();
  private readonly connectionStateCallbacks = new Set<
    (state: YjsTransportConnectionState) => void
  >();
  private connectionState: YjsTransportConnectionState;

  constructor(
    sendFn: (message: ClientMessage) => void,
    initialState: YjsTransportConnectionState
  ) {
    this.sendFn = sendFn;
    this.connectionState = initialState;
  }

  send(message: ClientMessage): void {
    this.sendFn(message);
  }

  // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
  onMessage(callback: (message: ServerMessage) => void): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  handleIncoming(message: ServerMessage): void {
    for (const callback of this.callbacks) {
      // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
      callback(message);
    }
  }

  onConnectionStateChange(
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback: (state: YjsTransportConnectionState) => void
  ): () => void {
    this.connectionStateCallbacks.add(callback);
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback(this.connectionState);
    return () => {
      this.connectionStateCallbacks.delete(callback);
    };
  }

  handleConnectionStateChange(state: YjsTransportConnectionState): void {
    if (state === this.connectionState) {
      return;
    }

    this.connectionState = state;
    for (const callback of this.connectionStateCallbacks) {
      // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
      callback(state);
    }
  }

  isConnected(): boolean {
    return this.connectionState === "connected";
  }
}
