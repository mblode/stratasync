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
  /*
   * Additive observability for `/how-it-works`, which renders the log itself
   * rather than only its effects. `onSyncFlow` keeps its single-callback shape
   * because `Showcase` owns that slot.
   */
  private readonly logListeners = new Set<() => void>();
  private logSnapshot: readonly SyncAction[] = [];
  /*
   * Ids allocated but not yet published. Off by default and `Showcase` never
   * turns it on; `/how-it-works` uses it to run the failure `bigserial` alone
   * cannot prevent, where a lower id commits after a higher one.
   */
  private deferCommits = false;
  private readonly deferred: { action: SyncAction; source: string }[] = [];
  onSyncFlow: SyncFlowCallback | null = null;

  constructor(seedRows: ModelRow[]) {
    this.rows = [...seedRows];
  }

  /**
   * The log, as a snapshot stable between appends so `useSyncExternalStore`
   * does not loop.
   */
  getLog(): readonly SyncAction[] {
    return this.logSnapshot;
  }

  onLogAppend(listener: () => void): () => void {
    this.logListeners.add(listener);
    return () => {
      this.logListeners.delete(listener);
    };
  }

  /** Back to a known state, so a figure can be replayed from step 0. */
  reset(seedRows: ModelRow[]): void {
    this.nextSyncId = 1;
    /*
     * Copied, not aliased: `applyAction` assigns into `row.data` in place, so
     * a figure replaying its scenario would otherwise be handed back a seed
     * the previous run had already edited.
     */
    this.rows.splice(
      0,
      this.rows.length,
      ...seedRows.map((row) => ({ ...row, data: { ...row.data } }))
    );
    this.syncLog.length = 0;
    this.deferCommits = false;
    this.deferred.length = 0;
    this.publishLog();
  }

  /**
   * Allocate a syncId when the write arrives but publish it only on
   * `commitDeferred` — which is what a `bigserial` does without
   * `acquireInsertOrderLock` holding the gap closed.
   */
  setDeferCommits(on: boolean): void {
    this.deferCommits = on;
  }

  /** Allocated and unpublished, in allocation order. */
  getDeferred(): readonly SyncAction[] {
    return this.deferred.map((entry) => entry.action);
  }

  /** Publish one held write. The index is what lets a figure commit out of order. */
  commitDeferred(index: number): void {
    const entry = this.deferred[index];
    if (!entry) {
      return;
    }
    this.deferred.splice(index, 1);
    this.commit(entry.action, entry.source);
  }

  private publishLog(): void {
    this.logSnapshot = [...this.syncLog];
    for (const listener of this.logListeners) {
      listener();
    }
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
      /*
       * Dedup on (clientId, clientTxId), as the real server does — a lookup
       * first, a unique-constraint fallback behind it
       * (`mutate-service.ts:498,601`). A retried transaction gets back the
       * syncId it already has and appends nothing, which is what makes a
       * resend safe.
       */
      const existing = this.findByClientTx(sourceTransportId, tx.clientTxId);
      if (existing) {
        return {
          clientTxId: tx.clientTxId,
          success: true,
          syncId: existing.id,
        };
      }

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

      if (this.deferCommits) {
        this.deferred.push({ action, source: sourceTransportId });
      } else {
        this.commit(action, sourceTransportId);
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

  private findByClientTx(
    clientId: string,
    clientTxId: string
  ): SyncAction | undefined {
    const match = (action: SyncAction) =>
      action.clientId === clientId && action.clientTxId === clientTxId;
    return (
      this.syncLog.find(match) ??
      this.deferred.find((entry) => match(entry.action))?.action
    );
  }

  /** Persist to the log, fold it into the rows, and broadcast the delta. */
  private commit(action: SyncAction, sourceTransportId: string): void {
    this.syncLog.push(action);
    this.publishLog();
    this.applyAction(action);

    const deltaPacket: DeltaPacket = {
      actions: [action],
      lastSyncId: action.id,
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

export interface WireItem {
  /** `up` is a mutation leaving the device; `down` is a delta arriving. */
  direction: "down" | "up";
  id: string;
  label: string;
}

let nextWireId = 0;

export class DemoTransport implements TransportAdapter {
  private readonly server: DemoServer;
  private readonly transportId: string;
  private deltaQueue = new AsyncQueue<DeltaPacket>();
  private readonly connectionListeners = new Set<
    (state: ConnectionState) => void
  >();
  private readonly pendingMutations: {
    batch: TransactionBatch;
    reject: (error: Error) => void;
    resolve: (result: MutateResult) => void;
  }[] = [];
  private latencyMs: number;
  private connectionState: ConnectionState = "connected";

  /*
   * One FIFO for both wire directions, so `hold` and `step` cannot reorder
   * packets. Off by default: unheld, `mutate` schedules on the same
   * `latencyMs` as before and `deliverDelta` stays synchronous, which is what
   * `Showcase`'s cross-device timing depends on.
   */
  private readonly wire: WireItem[] = [];
  private readonly heldQueue: { item: WireItem; run: () => void }[] = [];
  private readonly wireListeners = new Set<() => void>();
  private wireSnapshot: readonly WireItem[] = [];
  private held: "both" | "down" | "up" | null = null;

  isOnline = true;

  constructor(server: DemoServer, transportId: string, latencyMs = 300) {
    this.server = server;
    this.transportId = transportId;
    this.latencyMs = latencyMs;
    server.register(transportId, this);
  }

  // --- Public control methods ---

  /** What is in flight right now, oldest first. */
  getWire(): readonly WireItem[] {
    return this.wireSnapshot;
  }

  onWireChange(listener: () => void): () => void {
    this.wireListeners.add(listener);
    return () => {
      this.wireListeners.delete(listener);
    };
  }

  /**
   * Freeze the wire. Everything queues; nothing is dropped.
   *
   * The direction matters. Holding only `down` lets a mutation reach the server
   * and its ack come back — so a transaction really does reach `awaitingSync`
   * with a real `syncIdNeededForCompletion` — while the delta that would
   * advance this device's cursor sits visibly in flight. That frame is the
   * whole read-your-writes story, and it is not reachable with a single flag.
   */
  hold(direction: "both" | "down" | "up" = "both"): void {
    this.held = direction;
  }

  private isHeld(direction: "down" | "up"): boolean {
    return this.held === "both" || this.held === direction;
  }

  /** What is frozen right now, if anything. */
  getHold(): "both" | "down" | "up" | null {
    return this.held;
  }

  /** Let everything through, in the order it was queued. */
  release(direction?: "down" | "up"): void {
    if (direction === undefined) {
      this.held = null;
      for (const entry of this.heldQueue.splice(0)) {
        entry.run();
      }
      return;
    }

    if (this.held === "both") {
      this.held = direction === "down" ? "up" : "down";
    } else if (this.held === direction) {
      this.held = null;
    }

    const kept = this.heldQueue.filter(
      (entry) => entry.item.direction !== direction
    );
    const freed = this.heldQueue.filter(
      (entry) => entry.item.direction === direction
    );
    this.heldQueue.length = 0;
    this.heldQueue.push(...kept);
    for (const entry of freed) {
      entry.run();
    }
  }

  /** Let exactly one packet through, oldest first. */
  step(direction?: "down" | "up"): void {
    const index =
      direction === undefined
        ? 0
        : this.heldQueue.findIndex(
            (entry) => entry.item.direction === direction
          );
    if (index === -1) {
      return;
    }
    const [entry] = this.heldQueue.splice(index, 1);
    entry?.run();
  }

  /**
   * Undo `close()`.
   *
   * `client.clearAll()` resets its orchestrator, which calls
   * `transport.close()` — and close unregisters from the server and closes the
   * delta queue for good. The how-it-works page restarts the same client
   * against the same transport when a figure checks the engine out, so close
   * has to be reversible here. `Showcase` tears its transports down and never
   * reuses them, so nothing else observes this.
   */
  reopen(): void {
    /*
     * A reopened transport is a new connection, so nothing survives the gap.
     * Without this the held delta from the previous scenario is replayed into
     * the fresh queue the moment the hold lifts, and the reseeded client
     * applies a change to a row that no longer has the edit.
     */
    this.heldQueue.length = 0;
    this.pendingMutations.length = 0;
    this.wire.length = 0;
    this.publishWire();
    this.deltaQueue = new AsyncQueue<DeltaPacket>();
    this.server.register(this.transportId, this);
  }

  /**
   * Fail every buffered mutation, which is what killing the app does to a send
   * that never left. The client puts those transactions back to `queued` with
   * a `retryCount` (`outbox-manager.ts:372-395`) and replays them on restart —
   * so this is the only honest way to show a durable queue outliving its
   * client. `Showcase` never calls it.
   */
  abortPending(): void {
    for (const { reject } of this.pendingMutations.splice(0)) {
      reject(new Error("Transport closed"));
    }
  }

  setLatency(latencyMs: number): void {
    this.latencyMs = latencyMs;
  }

  private publishWire(): void {
    this.wireSnapshot = [...this.wire];
    for (const listener of this.wireListeners) {
      listener();
    }
  }

  private removeFromWire(id: string): void {
    const index = this.wire.findIndex((item) => item.id === id);
    if (index !== -1) {
      this.wire.splice(index, 1);
      this.publishWire();
    }
  }

  private enqueue(direction: "down" | "up", label: string, run: () => void) {
    nextWireId += 1;
    const item: WireItem = { direction, id: `w${nextWireId}`, label };
    this.wire.push(item);
    this.publishWire();

    const finish = () => {
      this.removeFromWire(item.id);
      run();
    };

    if (this.isHeld(direction)) {
      this.heldQueue.push({ item, run: finish });
      return;
    }

    this.scheduleResolve(finish);
  }

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
      // Through the wire, so a figure can watch the offline queue drain in
      // order. Unheld this schedules on the same `latencyMs` as before.
      this.enqueue(
        "up",
        `${batch.transactions.length} transaction${
          batch.transactions.length === 1 ? "" : "s"
        }`,
        () => resolve(this.server.processMutation(this.transportId, batch))
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
    if (!this.isHeld("down")) {
      // Synchronous, exactly as before. Only a held wire intercepts a delta.
      this.deltaQueue.push(packet);
      return;
    }

    nextWireId += 1;
    const item: WireItem = {
      direction: "down",
      id: `w${nextWireId}`,
      label: `${packet.actions.length} action${
        packet.actions.length === 1 ? "" : "s"
      } · syncId ${packet.lastSyncId}`,
    };
    this.wire.push(item);
    this.publishWire();
    this.heldQueue.push({
      item,
      run: () => {
        this.removeFromWire(item.id);
        this.deltaQueue.push(packet);
      },
    });
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

  async *batchLoad(
    _options: BatchLoadOptions
  ): AsyncGenerator<ModelRow, void, unknown> {
    // No-op for demo. Batch loading not needed.
  }

  mutate(batch: TransactionBatch): Promise<MutateResult> {
    if (!this.isOnline) {
      // Buffer while offline. Resolves when we come back online.
      return new Promise((resolve, reject) => {
        this.pendingMutations.push({ batch, reject, resolve });
      });
    }

    return new Promise((resolve) => {
      this.enqueue(
        "up",
        `${batch.transactions.length} transaction${
          batch.transactions.length === 1 ? "" : "s"
        }`,
        () => resolve(this.server.processMutation(this.transportId, batch))
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
