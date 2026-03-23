// oxlint-disable no-use-before-define -- helper functions are grouped after the class for readability
import type {
  ConnectionState,
  DeltaPacket,
  DeltaSubscription,
  SubscribeOptions,
  SyncId,
} from "@stratasync/core";
import { maxSyncId } from "@stratasync/core";

import { parseDeltaPacket } from "./protocol.js";
import type { AuthProvider, RetryConfig } from "./types.js";
import {
  calculateBackoff,
  createTransportError,
  notifyAuthError,
  parseSyncId,
  resolveAuthToken,
} from "./utils.js";

interface SubscriptionState {
  closed: boolean;
  error: Error | null;
  lastSyncId: SyncId;
  options: SubscribeOptions;
  pending: {
    resolve: (result: IteratorResult<DeltaPacket>) => void;
    reject: (error: unknown) => void;
  } | null;
  queue: DeltaPacket[];
}

/**
 * WebSocket connection manager for delta streaming
 */
export class WebSocketManager {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly wsEndpoint: string;
  private readonly auth: AuthProvider;
  private readonly webSocketFactory: typeof WebSocket;
  private connectionState: ConnectionState = "disconnected";
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private subscribedReady = false;
  private readonly subscribeStateListeners = new Set<
    (ready: boolean) => void
  >();
  private readonly subscriptions = new Set<SubscriptionState>();
  private readonly yjsMessageCallbacks = new Set<(message: unknown) => void>();
  private readonly pendingMessages: string[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscribeRetryAttempts = 0;
  private subscribeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSubscribeError: Error | null = null;
  private readonly retryConfig: RetryConfig;
  private shouldReconnect = true;

  constructor(
    wsEndpoint: string,
    auth: AuthProvider,
    retryConfig: RetryConfig,
    webSocketFactory?: typeof WebSocket
  ) {
    this.wsEndpoint = wsEndpoint;
    this.auth = auth;
    this.retryConfig = retryConfig;
    const defaultFactory = webSocketFactory ?? globalThis.WebSocket;
    if (!defaultFactory) {
      throw new Error("WebSocket is not available in this environment");
    }
    this.webSocketFactory = defaultFactory;
  }

  /**
   * Connects to the WebSocket server
   */
  async connect(): Promise<void> {
    if (this.socket) {
      if (this.connectPromise) {
        return this.connectPromise;
      }
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    const connectPromise = (async () => {
      this.shouldReconnect = true;
      this.setConnectionState(
        this.reconnectAttempts > 0 ? "reconnecting" : "connecting"
      );

      const token = await resolveAuthToken(this.auth);

      // close() may have been called while we were waiting on auth.
      if (!this.shouldReconnect) {
        return;
      }

      const url = token
        ? `${this.wsEndpoint}${this.wsEndpoint.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`
        : this.wsEndpoint;

      const socket = new this.webSocketFactory(url);
      this.socket = socket;

      socket.addEventListener("open", () => {
        this.reconnectAttempts = 0;
        if (this.subscribeRetryTimer) {
          clearTimeout(this.subscribeRetryTimer);
          this.subscribeRetryTimer = null;
        }
        this.setSubscribedReady(false);
        this.setConnectionState("connected");
        // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
        this.flushSubscriptions().catch(() => {
          // If subscription fails, reconnect will handle it.
        });
      });

      socket.addEventListener("message", (event) => {
        // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
        this.handleMessage(event).catch(() => {
          // Message parse errors are ignored.
        });
      });

      socket.addEventListener("close", () => {
        this.socket = null;
        this.setSubscribedReady(false);
        this.setConnectionState("disconnected");
        if (this.shouldReconnect && this.subscriptions.size > 0) {
          this.scheduleReconnect();
        }
      });

      socket.addEventListener("error", () => {
        this.setSubscribedReady(false);
        this.setConnectionState("error");
      });
    })();

    this.connectPromise = connectPromise;
    try {
      await connectPromise;
    } catch (error) {
      this.setSubscribedReady(false);
      this.setConnectionState("error");
      throw error;
    } finally {
      if (this.connectPromise === connectPromise) {
        this.connectPromise = null;
      }
    }
  }

  /**
   * Subscribes to delta updates
   */
  subscribe(options: SubscribeOptions): DeltaSubscription {
    if (this.hasActiveSubscription()) {
      throw new Error(
        "WebSocketManager supports only one active delta subscription"
      );
    }

    const state: SubscriptionState = {
      closed: false,
      error: null,
      lastSyncId: options.afterSyncId,
      options,
      pending: null,
      queue: [],
    };

    this.subscriptions.add(state);

    // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
    this.connect().catch(() => {
      // Connection will be retried automatically
    });

    if (this.socket?.readyState === WebSocket.OPEN) {
      // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
      this.sendSubscribe(state).catch(() => {
        // Retry on reconnect
      });
    }

    const iterator: AsyncIterator<DeltaPacket> = {
      next: () => {
        if (state.error) {
          return Promise.reject(state.error);
        }

        if (state.closed && state.queue.length === 0) {
          return Promise.resolve({
            done: true,
            value: undefined as unknown as DeltaPacket,
          });
        }

        const queued = state.queue.shift();
        if (queued) {
          return Promise.resolve({ done: false, value: queued });
        }

        // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
        return new Promise((resolve, reject) => {
          state.pending = { reject, resolve };
        });
      },
      return: () => {
        this.subscriptions.delete(state);
        WebSocketManager.closeSubscription(state);
        return Promise.resolve({
          done: true,
          value: undefined as unknown as DeltaPacket,
        });
      },
      throw: (error) => {
        this.subscriptions.delete(state);
        WebSocketManager.failSubscription(state, error);
        return Promise.reject(error);
      },
    };

    return {
      [Symbol.asyncIterator]: () => iterator,
      unsubscribe: () => {
        this.subscriptions.delete(state);
        WebSocketManager.closeSubscription(state);
      },
    };
  }

  /**
   * Gets the current connection state
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Registers a callback for connection state changes
   */
  onConnectionStateChange(
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback: (state: ConnectionState) => void
  ): () => void {
    this.stateListeners.add(callback);
    return () => {
      this.stateListeners.delete(callback);
    };
  }

  /**
   * Gets whether the server has acknowledged subscriptions for this socket.
   */
  isSubscribedReady(): boolean {
    return this.subscribedReady;
  }

  /**
   * Registers a callback for subscription-readiness changes.
   */
  // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
  onSubscribeStateChange(callback: (ready: boolean) => void): () => void {
    this.subscribeStateListeners.add(callback);
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback(this.subscribedReady);
    return () => {
      this.subscribeStateListeners.delete(callback);
    };
  }

  /**
   * Registers a callback for Yjs/live-editing messages.
   */
  // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
  onYjsMessage(callback: (message: unknown) => void): () => void {
    this.yjsMessageCallbacks.add(callback);
    return () => {
      this.yjsMessageCallbacks.delete(callback);
    };
  }

  /**
   * Sends a raw payload over the WebSocket (queues until subscribed).
   */
  sendRaw(payload: string): void {
    if (this.socket?.readyState === WebSocket.OPEN && this.subscribedReady) {
      this.socket.send(payload);
      return;
    }

    this.pendingMessages.push(payload);
    // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
    this.connect().catch(() => {
      // Connection errors are handled by retry logic
    });
  }

  /**
   * Closes the WebSocket connection
   */
  close(): Promise<void> {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.subscribeRetryTimer) {
      clearTimeout(this.subscribeRetryTimer);
      this.subscribeRetryTimer = null;
    }
    this.subscribeRetryAttempts = 0;
    this.lastSubscribeError = null;
    this.pendingMessages.length = 0;
    for (const subscription of this.subscriptions) {
      WebSocketManager.closeSubscription(subscription);
    }
    this.subscriptions.clear();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.setSubscribedReady(false);
    this.setConnectionState("disconnected");
    return Promise.resolve();
  }

  private setConnectionState(state: ConnectionState): void {
    if (this.connectionState !== state) {
      this.connectionState = state;
      for (const listener of this.stateListeners) {
        listener(state);
      }
    }
  }

  private setSubscribedReady(ready: boolean): void {
    if (this.subscribedReady === ready) {
      return;
    }

    this.subscribedReady = ready;
    for (const listener of this.subscribeStateListeners) {
      listener(ready);
    }
  }

  private hasActiveSubscription(): boolean {
    for (const subscription of this.subscriptions) {
      if (!subscription.closed) {
        return true;
      }
    }
    return false;
  }

  private static closeSubscription(subscription: SubscriptionState): void {
    if (subscription.closed) {
      return;
    }

    subscription.closed = true;
    if (subscription.pending) {
      subscription.pending.resolve({
        done: true,
        value: undefined as unknown as DeltaPacket,
      });
      subscription.pending = null;
    }
  }

  private static failSubscription(
    subscription: SubscriptionState,
    error: unknown
  ): void {
    if (subscription.closed) {
      return;
    }

    const failure = error instanceof Error ? error : new Error(String(error));
    subscription.closed = true;
    subscription.error = failure;
    if (subscription.pending) {
      subscription.pending.reject(failure);
      subscription.pending = null;
    }
  }

  private failSubscriptions(error: unknown): void {
    const subscriptions = [...this.subscriptions];
    this.subscriptions.clear();
    for (const subscription of subscriptions) {
      WebSocketManager.failSubscription(subscription, error);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.retryConfig.maxRetries) {
      this.setConnectionState("error");
      return;
    }

    const delay = calculateBackoff(this.reconnectAttempts, this.retryConfig);
    this.reconnectAttempts += 1;

    this.reconnectTimer = setTimeout(() => {
      // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
      this.connect().catch(() => {
        // Connection errors are handled by retry logic
      });
    }, delay);
  }

  private scheduleSubscribeRetry(): void {
    if (
      this.subscribeRetryTimer ||
      !this.shouldReconnect ||
      this.subscriptions.size === 0
    ) {
      return;
    }

    if (this.subscribeRetryAttempts >= this.retryConfig.maxRetries) {
      this.setConnectionState("error");
      this.failSubscriptions(
        this.lastSubscribeError ??
          createTransportError("Subscription retry limit exceeded", {
            code: "SUBSCRIBE_RETRY_LIMIT",
            retryable: false,
          })
      );
      return;
    }

    const delay = calculateBackoff(
      this.subscribeRetryAttempts,
      this.retryConfig
    );
    this.subscribeRetryAttempts += 1;

    this.subscribeRetryTimer = setTimeout(() => {
      this.subscribeRetryTimer = null;
      if (!this.shouldReconnect || this.subscriptions.size === 0) {
        return;
      }
      if (this.socket?.readyState === WebSocket.OPEN) {
        // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
        this.flushSubscriptions().catch(() => {
          // Subscription errors are retried
        });
        return;
      }
      // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
      this.connect().catch(() => {
        // Connection errors are handled by retry logic
      });
    }, delay);
  }

  private async flushSubscriptions(): Promise<void> {
    const subscriptions = [...this.subscriptions];
    for (const subscription of subscriptions) {
      if (subscription.closed) {
        continue;
      }
      await this.sendSubscribe(subscription);
    }
  }

  private flushPendingMessages(): void {
    const { socket } = this;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      !this.subscribedReady
    ) {
      return;
    }

    while (this.pendingMessages.length > 0) {
      if (
        this.socket !== socket ||
        socket.readyState !== WebSocket.OPEN ||
        !this.subscribedReady
      ) {
        return;
      }

      const [message] = this.pendingMessages;
      if (message === undefined) {
        return;
      }

      try {
        socket.send(message);
      } catch {
        // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
        this.connect().catch(() => {
          // Connection errors are handled by retry logic
        });
        return;
      }

      this.pendingMessages.shift();
    }
  }

  private async sendSubscribe(subscription: SubscriptionState): Promise<void> {
    const { socket } = this;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    let afterSyncId: SyncId;
    try {
      afterSyncId = parseSyncId(
        subscription.lastSyncId,
        "Subscribe afterSyncId"
      );
    } catch {
      this.setSubscribedReady(false);
      this.setConnectionState("error");
      this.lastSubscribeError = createTransportError(
        "Subscribe afterSyncId must be a string-encoded integer",
        {
          code: "INVALID_SUBSCRIPTION_CURSOR",
          retryable: false,
        }
      );
      this.subscriptions.delete(subscription);
      WebSocketManager.failSubscription(subscription, this.lastSubscribeError);
      return;
    }

    const token = await resolveAuthToken(this.auth);
    if (!token) {
      this.lastSubscribeError = createTransportError(
        "Subscribe token missing",
        {
          code: "AUTH_TOKEN_MISSING",
          retryable: true,
        }
      );
      this.scheduleSubscribeRetry();
      return;
    }

    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const message = {
      afterSyncId,
      groups: subscription.options.groups,
      token,
      type: "subscribe",
    };

    this.setSubscribedReady(false);
    socket.send(JSON.stringify(message));
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    const data = await readMessageData(event.data);
    if (!data) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    if (WebSocketManager.isSubscribedAckMessage(parsed)) {
      if (this.subscribeRetryTimer) {
        clearTimeout(this.subscribeRetryTimer);
        this.subscribeRetryTimer = null;
      }
      this.subscribeRetryAttempts = 0;
      this.lastSubscribeError = null;
      this.setConnectionState("connected");
      this.setSubscribedReady(true);
      this.flushPendingMessages();
      return;
    }

    const subscribeError = WebSocketManager.parseSubscribeErrorMessage(parsed);
    if (subscribeError) {
      this.setSubscribedReady(false);
      this.setConnectionState("error");
      this.lastSubscribeError = createTransportError(subscribeError.message, {
        code: subscribeError.code ?? "SUBSCRIBE_ERROR",
        retryable: subscribeError.code !== "BOOTSTRAP_REQUIRED",
      });
      if (WebSocketManager.isAuthSubscribeError(subscribeError)) {
        notifyAuthError(this.auth, this.lastSubscribeError);
      }
      if (subscribeError.code === "BOOTSTRAP_REQUIRED") {
        this.failSubscriptions(this.lastSubscribeError);
        return;
      }
      this.scheduleSubscribeRetry();
      return;
    }

    if (WebSocketManager.isLiveEditingMessage(parsed)) {
      this.emitYjsMessage(parsed);
      return;
    }

    const packet = parseDeltaPacket(parsed);
    if (!packet) {
      return;
    }

    for (const subscription of this.subscriptions) {
      if (subscription.closed) {
        continue;
      }
      subscription.lastSyncId = maxSyncId(
        subscription.lastSyncId,
        packet.lastSyncId
      );

      if (subscription.pending) {
        subscription.pending.resolve({ done: false, value: packet });
        subscription.pending = null;
      } else {
        subscription.queue.push(packet);
      }
    }
  }

  private emitYjsMessage(message: unknown): void {
    for (const callback of this.yjsMessageCallbacks) {
      // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
      callback(message);
    }
  }

  private static isLiveEditingMessage(message: unknown): boolean {
    if (typeof message !== "object" || message === null) {
      return false;
    }

    const typeValue = (message as Record<string, unknown>).type;
    if (typeof typeValue !== "string") {
      return false;
    }

    return (
      typeValue.startsWith("yjs_") ||
      typeValue.startsWith("doc_") ||
      typeValue.startsWith("session_") ||
      typeValue.startsWith("live_editing_")
    );
  }

  private static isSubscribedAckMessage(message: unknown): boolean {
    if (typeof message !== "object" || message === null) {
      return false;
    }

    return (message as Record<string, unknown>).type === "subscribed";
  }

  private static parseSubscribeErrorMessage(message: unknown): {
    code?: string;
    message: string;
  } | null {
    if (typeof message !== "object" || message === null) {
      return null;
    }

    const record = message as Record<string, unknown>;
    if (record.type !== "error") {
      return null;
    }

    return {
      code: typeof record.code === "string" ? record.code : undefined,
      message:
        typeof record.message === "string"
          ? record.message
          : "Subscription failed",
    };
  }

  private static isAuthSubscribeError(error: {
    code?: string;
    message: string;
  }): boolean {
    const message = error.message.toLowerCase();
    return (
      error.code === "UNAUTHORIZED" ||
      message.includes("auth") ||
      message.includes("token") ||
      message.includes("unauthorized")
    );
  }
}

const readMessageData = async (
  data: MessageEvent["data"]
): Promise<string | null> => {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }

  if (data instanceof Blob) {
    return await data.text();
  }

  return null;
};
