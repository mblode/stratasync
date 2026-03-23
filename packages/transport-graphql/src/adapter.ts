import type { TransportAdapter } from "@stratasync/client";
import type {
  BatchLoadOptions,
  BootstrapMetadata,
  BootstrapOptions,
  ConnectionState,
  DeltaPacket,
  DeltaSubscription,
  ModelRow,
  MutateResult,
  SubscribeOptions,
  SyncId,
  TransactionBatch,
} from "@stratasync/core";
import {
  isLiveEditingErrorMessage,
  isSessionStateMessage,
  isYjsSyncStep2Message,
  isYjsUpdateMessage,
} from "@stratasync/y-doc";

import { createBatchLoadStream, createBootstrapStream } from "./bootstrap.js";
import { fetchDeltas } from "./deltas.js";
import { sendMutations, sendRestMutations } from "./mutations.js";
import { joinSyncUrl, normalizeSyncEndpoint } from "./protocol.js";
import type { RetryConfig, TransportOptions } from "./types.js";
import { DEFAULT_RETRY_CONFIG } from "./types.js";
import { WebSocketManager } from "./websocket.js";
import { YjsTransportAdapter } from "./yjs-transport.js";

/**
 * GraphQL transport adapter implementation
 */
export class GraphQLTransportAdapter implements TransportAdapter {
  private readonly options: TransportOptions;
  private readonly wsManager: WebSocketManager;
  private connectionState: ConnectionState = "disconnected";
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private readonly retryConfig: RetryConfig;
  private readonly syncEndpoint: string;
  private yjsTransport: YjsTransportAdapter | null = null;
  private yjsMessageUnsubscribe: (() => void) | null = null;

  constructor(options: TransportOptions) {
    this.options = options;
    this.retryConfig = options.retry ?? DEFAULT_RETRY_CONFIG;
    if (!options.syncEndpoint) {
      throw new Error("syncEndpoint is required");
    }
    this.syncEndpoint = options.syncEndpoint;
    this.wsManager = new WebSocketManager(
      options.wsEndpoint,
      options.auth,
      this.retryConfig,
      options.webSocketFactory
    );

    // Forward WebSocket connection state changes
    this.wsManager.onConnectionStateChange((state) => {
      this.setConnectionState(state);
      this.syncYjsConnectionState(state, this.wsManager.isSubscribedReady());
    });

    this.wsManager.onSubscribeStateChange((ready) => {
      this.syncYjsConnectionState(this.wsManager.getConnectionState(), ready);
    });
  }

  bootstrap(
    options: BootstrapOptions
  ): AsyncGenerator<ModelRow, BootstrapMetadata, unknown> {
    return createBootstrapStream({
      auth: this.options.auth,
      bootstrapOptions: options,
      headers: this.options.headers,
      retryConfig: this.retryConfig,
      syncEndpoint: this.syncEndpoint,
      timeoutMs: this.options.timeout,
    });
  }

  batchLoad(options: BatchLoadOptions): AsyncIterable<ModelRow> {
    return createBatchLoadStream({
      auth: this.options.auth,
      batchLoadOptions: options,
      headers: this.options.headers,
      retryConfig: this.retryConfig,
      syncEndpoint: this.syncEndpoint,
      timeoutMs: this.options.timeout,
    });
  }

  mutate(batch: TransactionBatch): Promise<MutateResult> {
    // Use REST endpoint when no GraphQL mutation builder is configured
    if (!this.options.mutationBuilder) {
      const syncBase = normalizeSyncEndpoint(this.syncEndpoint);
      return sendRestMutations({
        auth: this.options.auth,
        batch,
        endpoint: joinSyncUrl(syncBase, "/mutate"),
        headers: this.options.headers,
        retryConfig: this.retryConfig,
        timeoutMs: this.options.timeout,
      });
    }

    // Otherwise use GraphQL
    return sendMutations({
      auth: this.options.auth,
      batch,
      endpoint: this.options.endpoint,
      headers: this.options.headers,
      mutationBuilder: this.options.mutationBuilder,
      retryConfig: this.retryConfig,
      timeoutMs: this.options.timeout,
    });
  }

  subscribe(options: SubscribeOptions): DeltaSubscription {
    return this.wsManager.subscribe(options);
  }

  getYjsTransport(): YjsTransportAdapter {
    if (this.yjsTransport) {
      return this.yjsTransport;
    }

    const adapter = new YjsTransportAdapter((message) => {
      this.wsManager.sendRaw(JSON.stringify(message));
    }, this.getYjsConnectionState());

    this.yjsMessageUnsubscribe = this.wsManager.onYjsMessage((message) => {
      if (
        isYjsSyncStep2Message(message) ||
        isYjsUpdateMessage(message) ||
        isSessionStateMessage(message) ||
        isLiveEditingErrorMessage(message)
      ) {
        adapter.handleIncoming(message);
      }
    });

    this.yjsTransport = adapter;
    return adapter;
  }

  fetchDeltas(
    after: SyncId,
    limit?: number,
    groups?: string[]
  ): Promise<DeltaPacket> {
    return fetchDeltas({
      afterSyncId: after,
      auth: this.options.auth,
      groups,
      headers: this.options.headers,
      limit,
      retryConfig: this.retryConfig,
      syncEndpoint: this.syncEndpoint,
      timeoutMs: this.options.timeout,
    });
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  onConnectionStateChange(
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback: (state: ConnectionState) => void
  ): () => void {
    this.stateListeners.add(callback);
    return () => {
      this.stateListeners.delete(callback);
    };
  }

  async close(): Promise<void> {
    await this.wsManager.close();
    this.yjsMessageUnsubscribe?.();
    this.yjsMessageUnsubscribe = null;
    this.yjsTransport?.dispose();
    this.yjsTransport = null;
    this.setConnectionState("disconnected");
    this.stateListeners.clear();
  }

  private setConnectionState(state: ConnectionState): void {
    if (this.connectionState !== state) {
      this.connectionState = state;
      for (const listener of this.stateListeners) {
        listener(state);
      }
    }
  }

  private getYjsConnectionState(): ConnectionState {
    return GraphQLTransportAdapter.resolveYjsConnectionState(
      this.wsManager.getConnectionState(),
      this.wsManager.isSubscribedReady()
    );
  }

  private syncYjsConnectionState(
    wsState: ConnectionState,
    subscribeReady: boolean
  ): void {
    if (!this.yjsTransport) {
      return;
    }

    this.yjsTransport.handleConnectionStateChange(
      GraphQLTransportAdapter.resolveYjsConnectionState(wsState, subscribeReady)
    );
  }

  private static resolveYjsConnectionState(
    wsState: ConnectionState,
    subscribeReady: boolean
  ): ConnectionState {
    if (wsState !== "connected") {
      return wsState;
    }
    return subscribeReady ? "connected" : "connecting";
  }
}

export const createGraphQLTransport = (
  options: TransportOptions
): GraphQLTransportAdapter => new GraphQLTransportAdapter(options);
