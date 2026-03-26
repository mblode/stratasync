/* eslint-disable eslint-plugin-promise/avoid-new, eslint-plugin-promise/prefer-await-to-callbacks, max-classes-per-file, class-methods-use-this */
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
  SyncAction,
  TransactionBatch,
} from "@stratasync/core";

// ---------------------------------------------------------------------------
// AsyncQueue: buffered async iterable for delta subscription
// ---------------------------------------------------------------------------

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly resolvers: ((result: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) {
      return;
    }
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ done: false, value: item });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const resolver of this.resolvers.splice(0)) {
      resolver({ done: true, value: undefined as T });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.items.shift();
        if (item !== undefined) {
          return Promise.resolve({ done: false, value: item });
        }
        if (this.closed) {
          return Promise.resolve({ done: true, value: undefined as T });
        }
        return new Promise((resolve) => {
          this.resolvers.push(resolve);
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ done: true, value: undefined as T });
      },
    };
  }
}

// ---------------------------------------------------------------------------
// DemoServer: shared state that both transports connect to
// ---------------------------------------------------------------------------

export type SyncFlowCallback = (direction: "left" | "right") => void;

export class DemoServer {
  private nextSyncId = 1;
  private readonly transports = new Map<string, DemoTransport>();
  private readonly rows: ModelRow[] = [];
  private readonly syncLog: SyncAction[] = [];
  onSyncFlow: SyncFlowCallback | null = null;

  constructor(seedRows: ModelRow[]) {
    this.rows = [...seedRows];
  }

  register(id: string, transport: DemoTransport): void {
    this.transports.set(id, transport);
  }

  unregister(id: string): void {
    this.transports.delete(id);
  }

  getRows(): ModelRow[] {
    return this.rows;
  }

  getLastSyncId(): string {
    return String(this.nextSyncId);
  }

  getSyncActions(afterSyncId: string): SyncAction[] {
    const after = Number(afterSyncId);
    return this.syncLog.filter((a) => Number(a.id) > after);
  }

  /**
   * Process a mutation batch from a transport. Returns the MutateResult and
   * broadcasts deltas to all OTHER connected transports.
   */
  processMutation(
    sourceTransportId: string,
    batch: TransactionBatch
  ): MutateResult {
    const results = batch.transactions.map((tx) => {
      this.nextSyncId += 1;
      const syncId = String(this.nextSyncId);

      const action: SyncAction = {
        action: tx.action,
        clientId: sourceTransportId,
        clientTxId: tx.clientTxId,
        data: tx.payload,
        id: syncId,
        modelId: tx.modelId,
        modelName: tx.modelName,
      };

      // Persist to sync log and update server rows
      this.syncLog.push(action);
      this.applyAction(action);

      // Broadcast deltas to other connected transports
      const deltaPacket: DeltaPacket = {
        actions: [action],
        lastSyncId: syncId,
      };

      for (const [id, transport] of this.transports) {
        if (!transport.isOnline) {
          continue;
        }

        if (id !== sourceTransportId) {
          // Animate sync flow for cross-device deltas
          const direction =
            sourceTransportId === "A" ? "right" : ("left" as const);
          this.onSyncFlow?.(direction);
        }

        // Deliver to ALL transports (including source). The sync engine
        // uses the echo to confirm outbox transactions via clientTxId matching
        transport.deliverDelta(deltaPacket);
      }

      return {
        clientTxId: tx.clientTxId,
        success: true,
        syncId,
      };
    });

    return {
      lastSyncId: String(this.nextSyncId),
      results,
      success: true,
    };
  }

  private applyAction(action: SyncAction): void {
    if (action.action === "I") {
      this.rows.push({
        data: { id: action.modelId, ...action.data },
        modelName: action.modelName,
      });
    } else if (action.action === "U") {
      const row = this.rows.find(
        (r) => r.modelName === action.modelName && r.data.id === action.modelId
      );
      if (row) {
        Object.assign(row.data, action.data);
      }
    } else if (action.action === "D") {
      const index = this.rows.findIndex(
        (r) => r.modelName === action.modelName && r.data.id === action.modelId
      );
      if (index !== -1) {
        this.rows.splice(index, 1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// DemoTransport: per-client transport wired to the DemoServer
// ---------------------------------------------------------------------------

export class DemoTransport implements TransportAdapter {
  private readonly server: DemoServer;
  private readonly transportId: string;
  private readonly deltaQueue = new AsyncQueue<DeltaPacket>();
  private readonly connectionListeners = new Set<
    (state: ConnectionState) => void
  >();
  private readonly pendingMutations: {
    batch: TransactionBatch;
    resolve: (result: MutateResult) => void;
  }[] = [];
  private readonly latencyMs: number;
  private connectionState: ConnectionState = "connected";

  isOnline = true;

  constructor(server: DemoServer, transportId: string, latencyMs = 300) {
    this.server = server;
    this.transportId = transportId;
    this.latencyMs = latencyMs;
    server.register(transportId, this);
  }

  // --- Public control methods ---

  setOnline(online: boolean): void {
    this.isOnline = online;
    this.connectionState = online ? "connected" : "disconnected";
    for (const listener of this.connectionListeners) {
      listener(this.connectionState);
    }
    if (online) {
      this.flushPendingMutations();
    }
  }

  private flushPendingMutations(): void {
    const queued = this.pendingMutations.splice(0);
    for (const { batch, resolve } of queued) {
      this.scheduleResolve(() =>
        resolve(this.server.processMutation(this.transportId, batch))
      );
    }
  }

  private scheduleResolve(fn: () => void): void {
    if (this.latencyMs === 0) {
      queueMicrotask(fn);
    } else {
      setTimeout(fn, this.latencyMs);
    }
  }

  deliverDelta(packet: DeltaPacket): void {
    this.deltaQueue.push(packet);
  }

  // --- TransportAdapter implementation ---

  bootstrap(
    _options: BootstrapOptions
  ): AsyncGenerator<ModelRow, BootstrapMetadata, unknown> {
    const rows = this.server.getRows();
    const lastSyncId = this.server.getLastSyncId();

    return (async function* generate() {
      await Promise.resolve();
      for (const row of rows) {
        yield { data: { ...row.data }, modelName: row.modelName };
      }
      return {
        lastSyncId,
        subscribedSyncGroups: [],
      } satisfies BootstrapMetadata;
    })();
  }

  // biome-ignore lint: required by TransportAdapter interface
  async *batchLoad(
    _options: BatchLoadOptions
  ): AsyncGenerator<ModelRow, void, unknown> {
    // No-op for demo. Batch loading not needed.
  }

  mutate(batch: TransactionBatch): Promise<MutateResult> {
    if (!this.isOnline) {
      // Buffer while offline. Resolves when we come back online.
      return new Promise((resolve) => {
        this.pendingMutations.push({ batch, resolve });
      });
    }

    return new Promise((resolve) => {
      this.scheduleResolve(() =>
        resolve(this.server.processMutation(this.transportId, batch))
      );
    });
  }

  subscribe(_options: SubscribeOptions): DeltaSubscription {
    return {
      [Symbol.asyncIterator]: () => this.deltaQueue[Symbol.asyncIterator](),
      unsubscribe: () => this.deltaQueue.close(),
    };
  }

  fetchDeltas(
    after: string,
    _limit?: number,
    _groups?: string[]
  ): Promise<DeltaPacket> {
    const actions = this.server.getSyncActions(after);
    return Promise.resolve({
      actions,
      lastSyncId: actions.length > 0 ? (actions.at(-1)?.id ?? after) : after,
    });
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  onConnectionStateChange(
    callback: (state: ConnectionState) => void
  ): () => void {
    this.connectionListeners.add(callback);
    callback(this.connectionState);
    return () => {
      this.connectionListeners.delete(callback);
    };
  }

  close(): Promise<void> {
    this.server.unregister(this.transportId);
    this.deltaQueue.close();
    return Promise.resolve();
  }
}
