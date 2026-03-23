/* oxlint-disable max-classes-per-file */
import { setTimeout as delay } from "node:timers/promises";

import {
  ClientModel,
  Model,
  noopReactivityAdapter,
  Property,
} from "../../core/src/index";
import type {
  BatchLoadOptions,
  BootstrapMetadata,
  BootstrapOptions,
  ConnectionState,
  DeltaPacket,
  DeltaSubscription,
  ModelRegistrySnapshot,
  ModelRow,
  MutateResult,
  SchemaDefinition,
  SubscribeOptions,
  SyncAction,
  Transaction,
  TransactionBatch,
} from "../../core/src/index";
import { IdentityMapRegistry } from "../src/identity-map";
import { createSyncClient } from "../src/index";
import { SyncOrchestrator } from "../src/sync-orchestrator";
import type {
  ClearStorageOptions,
  ModelPersistenceMeta,
  StorageAdapter,
  StorageMeta,
  TransportAdapter,
} from "../src/types";

class InMemoryStorage implements StorageAdapter {
  private readonly data = new Map<
    string,
    Map<string, Record<string, unknown>>
  >();
  private meta: StorageMeta = { lastSyncId: "0" };
  private readonly modelPersistence = new Map<string, boolean>();
  private readonly outbox: Transaction[] = [];
  private readonly partialIndexes = new Set<string>();
  private readonly syncActions: SyncAction[] = [];

  open(_options: {
    name?: string;
    userId?: string;
    version?: number;
    userVersion?: number;
    schema?: SchemaDefinition | ModelRegistrySnapshot;
  }): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  private getModelStore(
    modelName: string
  ): Map<string, Record<string, unknown>> {
    const existing = this.data.get(modelName);
    if (existing) {
      return existing;
    }
    const created = new Map<string, Record<string, unknown>>();
    this.data.set(modelName, created);
    return created;
  }

  get<T>(modelName: string, id: string): Promise<T | null> {
    const store = this.data.get(modelName);
    if (!store) {
      return Promise.resolve(null);
    }
    return Promise.resolve((store.get(id) as T | undefined) ?? null);
  }

  getAll<T>(modelName: string): Promise<T[]> {
    const store = this.data.get(modelName);
    if (!store) {
      return Promise.resolve([]);
    }
    return Promise.resolve([...store.values()] as T[]);
  }

  put<T extends Record<string, unknown>>(
    modelName: string,
    row: T
  ): Promise<void> {
    const { id } = row;
    if (typeof id !== "string") {
      throw new TypeError(`Missing id for model ${modelName}`);
    }
    const store = this.getModelStore(modelName);
    store.set(id, { ...row });
    return Promise.resolve();
  }

  delete(modelName: string, id: string): Promise<void> {
    this.data.get(modelName)?.delete(id);
    return Promise.resolve();
  }

  getByIndex<T>(
    modelName: string,
    indexName: string,
    key: string
  ): Promise<T[]> {
    const store = this.data.get(modelName);
    if (!store) {
      return Promise.resolve([]);
    }
    const results: T[] = [];
    for (const row of store.values()) {
      if (row[indexName] === key) {
        results.push(row as T);
      }
    }
    return Promise.resolve(results);
  }

  async writeBatch(
    ops: {
      type: "put" | "delete";
      modelName: string;
      id?: string;
      data?: Record<string, unknown>;
    }[]
  ): Promise<void> {
    for (const op of ops) {
      if (op.type === "put" && op.data) {
        await this.put(op.modelName, op.data);
        continue;
      }
      if (op.type === "delete" && op.id) {
        await this.delete(op.modelName, op.id);
      }
    }
  }

  getMeta(): Promise<StorageMeta> {
    const { subscribedSyncGroups } = this.meta;
    return Promise.resolve({
      ...this.meta,
      subscribedSyncGroups: Array.isArray(subscribedSyncGroups)
        ? [...subscribedSyncGroups]
        : undefined,
    });
  }

  setMeta(meta: Partial<StorageMeta>): Promise<void> {
    const { subscribedSyncGroups } = meta;
    this.meta = {
      ...this.meta,
      ...meta,
      subscribedSyncGroups: Array.isArray(subscribedSyncGroups)
        ? [...subscribedSyncGroups]
        : this.meta.subscribedSyncGroups,
    };
    return Promise.resolve();
  }

  getModelPersistence(modelName: string): Promise<ModelPersistenceMeta> {
    return Promise.resolve({
      modelName,
      persisted: this.modelPersistence.get(modelName) ?? false,
    });
  }

  setModelPersistence(modelName: string, persisted: boolean): Promise<void> {
    this.modelPersistence.set(modelName, persisted);
    return Promise.resolve();
  }

  getOutbox(): Promise<Transaction[]> {
    return Promise.resolve([...this.outbox]);
  }

  addToOutbox(tx: Transaction): Promise<void> {
    this.outbox.push(tx);
    return Promise.resolve();
  }

  removeFromOutbox(clientTxId: string): Promise<void> {
    const index = this.outbox.findIndex((tx) => tx.clientTxId === clientTxId);
    if (index !== -1) {
      this.outbox.splice(index, 1);
    }
    return Promise.resolve();
  }

  updateOutboxTransaction(
    clientTxId: string,
    updates: Partial<Transaction>
  ): Promise<void> {
    const tx = this.outbox.find((entry) => entry.clientTxId === clientTxId);
    if (tx) {
      Object.assign(tx, updates);
    }
    return Promise.resolve();
  }

  hasPartialIndex(
    modelName: string,
    indexedKey: string,
    keyValue: string
  ): Promise<boolean> {
    return Promise.resolve(
      this.partialIndexes.has(`${modelName}:${indexedKey}:${keyValue}`)
    );
  }

  setPartialIndex(
    modelName: string,
    indexedKey: string,
    keyValue: string
  ): Promise<void> {
    this.partialIndexes.add(`${modelName}:${indexedKey}:${keyValue}`);
    return Promise.resolve();
  }

  addSyncActions(actions: SyncAction[]): Promise<void> {
    this.syncActions.push(...actions);
    return Promise.resolve();
  }

  getSyncActions(afterSyncId?: string, limit?: number): Promise<SyncAction[]> {
    const filtered = afterSyncId
      ? this.syncActions.filter((action) => action.id > afterSyncId)
      : [...this.syncActions];
    if (typeof limit === "number") {
      return Promise.resolve(filtered.slice(0, limit));
    }
    return Promise.resolve(filtered);
  }

  clearSyncActions(): Promise<void> {
    this.syncActions.length = 0;
    return Promise.resolve();
  }

  clear(options?: ClearStorageOptions): Promise<void> {
    this.data.clear();
    this.modelPersistence.clear();
    if (!options?.preserveOutbox) {
      this.outbox.length = 0;
    }
    this.partialIndexes.clear();
    this.syncActions.length = 0;
    this.meta = { lastSyncId: "0" };
    return Promise.resolve();
  }

  count(modelName: string): Promise<number> {
    return Promise.resolve(this.data.get(modelName)?.size ?? 0);
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

const createDeferred = <T>(): Deferred<T> => {
  let resolve: ((value?: T | PromiseLike<T>) => void) | null = null;
  let reject: ((reason?: unknown) => void) | null = null;
  // oxlint-disable-next-line avoid-new, param-names -- wrapping callback API in promise; outer vars shadow resolve/reject
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  if (!(resolve && reject)) {
    throw new Error("Failed to create deferred promise");
  }
  return { promise, reject, resolve };
};

class BlockingSyncActionStorage extends InMemoryStorage {
  private readonly blockedSyncId: string;
  private readonly blocked = createDeferred<undefined>();
  private readonly release = createDeferred<undefined>();
  private hasBlocked = false;

  constructor(blockedSyncId: string) {
    super();
    this.blockedSyncId = blockedSyncId;
  }

  async addSyncActions(actions: SyncAction[]): Promise<void> {
    if (
      !this.hasBlocked &&
      actions.some((action) => action.id === this.blockedSyncId)
    ) {
      this.hasBlocked = true;
      this.blocked.resolve();
      await this.release.promise;
    }
    await super.addSyncActions(actions);
  }

  waitUntilBlocked(): Promise<void> {
    return this.blocked.promise;
  }

  unblock(): void {
    this.release.resolve();
  }
}

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
        // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
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

class TestTransport implements TransportAdapter {
  private deltaQueue = new AsyncQueue<DeltaPacket>();
  private readonly fullRows: ModelRow[];
  private readonly fullMetadata: BootstrapMetadata;
  private readonly batchRows: ModelRow[];
  private readonly partialRowsByGroup: Map<string, ModelRow[]>;
  private readonly fetchDeltaPackets: DeltaPacket[];
  private readonly connectionListeners = new Set<
    (state: ConnectionState) => void
  >();
  private readonly connectionState: ConnectionState = "connected";
  private nextSyncId: number;

  readonly bootstrapCalls: BootstrapOptions[] = [];
  readonly batchLoadCalls: BatchLoadOptions[] = [];
  readonly fetchDeltaCalls: {
    after: string;
    limit?: number;
    groups?: string[];
  }[] = [];
  readonly subscribeCalls: SubscribeOptions[] = [];

  constructor(options: {
    fullRows: ModelRow[];
    fullMetadata: BootstrapMetadata;
    batchRows?: ModelRow[];
    partialRowsByGroup?: Map<string, ModelRow[]>;
    startingSyncId?: number;
    fetchDeltaPacket?: DeltaPacket;
    fetchDeltaPackets?: DeltaPacket[];
  }) {
    this.fullRows = options.fullRows;
    this.fullMetadata = options.fullMetadata;
    this.batchRows = options.batchRows ?? [];
    this.partialRowsByGroup = options.partialRowsByGroup ?? new Map();
    this.nextSyncId = options.startingSyncId ?? 100;
    if (options.fetchDeltaPackets) {
      this.fetchDeltaPackets = [...options.fetchDeltaPackets];
    } else if (options.fetchDeltaPacket) {
      this.fetchDeltaPackets = [options.fetchDeltaPacket];
    } else {
      this.fetchDeltaPackets = [];
    }
  }

  private nextSyncIdString(): string {
    return String(this.nextSyncId);
  }

  bootstrap(
    options: BootstrapOptions
  ): AsyncGenerator<ModelRow, BootstrapMetadata, unknown> {
    this.bootstrapCalls.push(options);
    const isPartial = options.type === "partial";
    const rows = isPartial
      ? this.getPartialRows(options.syncGroups ?? [])
      : this.fullRows;
    const metadata = isPartial
      ? { subscribedSyncGroups: options.syncGroups ?? [] }
      : this.fullMetadata;

    return (async function* generate() {
      await Promise.resolve();
      for (const row of rows) {
        yield row;
      }
      return metadata;
    })();
  }

  private getPartialRows(groups: string[]): ModelRow[] {
    const rows: ModelRow[] = [];
    for (const group of groups) {
      const groupRows = this.partialRowsByGroup.get(group);
      if (groupRows) {
        rows.push(...groupRows);
      }
    }
    return rows;
  }

  batchLoad(
    options: BatchLoadOptions
  ): AsyncGenerator<ModelRow, void, unknown> {
    this.batchLoadCalls.push({
      firstSyncId: options.firstSyncId,
      requests: options.requests.map((request) => ({ ...request })),
    });
    const rows = this.batchRows.filter((row) =>
      options.requests.some((request) => {
        if (request.modelName !== row.modelName) {
          return false;
        }
        if ("groupId" in request) {
          return true;
        }

        return row.data[request.indexedKey] === request.keyValue;
      })
    );

    return (async function* generate() {
      await Promise.resolve();
      yield* rows;
    })();
  }

  mutate(batch: TransactionBatch): Promise<MutateResult> {
    const results = batch.transactions.map((tx) => {
      this.nextSyncId += 1;
      return {
        clientTxId: tx.clientTxId,
        success: true,
        syncId: this.nextSyncIdString(),
      };
    });

    return Promise.resolve({
      lastSyncId: this.nextSyncIdString(),
      results,
      success: true,
    });
  }

  subscribe(_options: SubscribeOptions): DeltaSubscription {
    this.subscribeCalls.push(_options);
    const queue = new AsyncQueue<DeltaPacket>();
    this.deltaQueue = queue;
    return {
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
      unsubscribe: () => queue.close(),
    };
  }

  emitDelta(packet: DeltaPacket): void {
    this.deltaQueue.push(packet);
  }

  fetchDeltas(
    after: string,
    _limit?: number,
    groups?: string[]
  ): Promise<DeltaPacket> {
    this.fetchDeltaCalls.push({ after, groups, limit: _limit });
    return Promise.resolve(
      this.fetchDeltaPackets.shift() ?? { actions: [], lastSyncId: after }
    );
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  onConnectionStateChange(
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback: (state: ConnectionState) => void
  ): () => void {
    this.connectionListeners.add(callback);
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback(this.connectionState);
    return () => {
      this.connectionListeners.delete(callback);
    };
  }

  close(): Promise<void> {
    this.deltaQueue.close();
    return Promise.resolve();
  }
}

// oxlint-disable-next-line require-yield -- intentionally empty generator for batchLoad stub
const emptyBatchGenerator =
  async function* emptyBatchGeneratorImpl(): AsyncGenerator<
    ModelRow,
    void,
    unknown
  > {
    // intentionally empty
  };

class ReconnectableTransport implements TransportAdapter {
  private readonly connectionListeners = new Set<
    (state: ConnectionState) => void
  >();
  private readonly fullRows: ModelRow[];
  private readonly fullMetadata: BootstrapMetadata;
  private currentQueue: AsyncQueue<DeltaPacket> | null = null;
  private connectionState: ConnectionState = "connected";

  readonly bootstrapCalls: BootstrapOptions[] = [];
  readonly subscribeCalls: SubscribeOptions[] = [];

  constructor(options: {
    fullRows: ModelRow[];
    fullMetadata: BootstrapMetadata;
  }) {
    this.fullRows = options.fullRows;
    this.fullMetadata = options.fullMetadata;
  }

  bootstrap(
    options: BootstrapOptions
  ): AsyncGenerator<ModelRow, BootstrapMetadata, unknown> {
    this.bootstrapCalls.push(options);
    const rows = [...this.fullRows];
    const metadata = this.fullMetadata;

    return (async function* generate() {
      await Promise.resolve();
      yield* rows;
      return metadata;
    })();
  }

  batchLoad(): AsyncGenerator<ModelRow, void, unknown> {
    return emptyBatchGenerator();
  }

  mutate(batch: TransactionBatch): Promise<MutateResult> {
    return Promise.resolve({
      lastSyncId: "1",
      results: batch.transactions.map((tx) => ({
        clientTxId: tx.clientTxId,
        success: true,
        syncId: "1",
      })),
      success: true,
    });
  }

  subscribe(options: SubscribeOptions): DeltaSubscription {
    this.subscribeCalls.push(options);
    const queue = new AsyncQueue<DeltaPacket>();
    this.currentQueue = queue;
    return {
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
      unsubscribe: () => queue.close(),
    };
  }

  emitDelta(packet: DeltaPacket): void {
    this.currentQueue?.push(packet);
  }

  closeCurrentSubscription(): void {
    this.currentQueue?.close();
  }

  fetchDeltas(after: string): Promise<DeltaPacket> {
    return Promise.resolve({ actions: [], hasMore: false, lastSyncId: after });
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  onConnectionStateChange(
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback: (state: ConnectionState) => void
  ): () => void {
    this.connectionListeners.add(callback);
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback(this.connectionState);
    return () => {
      this.connectionListeners.delete(callback);
    };
  }

  setConnectionState(state: ConnectionState): void {
    if (this.connectionState === state) {
      return;
    }

    this.connectionState = state;
    for (const listener of this.connectionListeners) {
      listener(state);
    }
  }

  getConnectionListenerCount(): number {
    return this.connectionListeners.size;
  }

  close(): Promise<void> {
    this.currentQueue?.close();
    return Promise.resolve();
  }
}

class BootstrapRequiredTransport implements TransportAdapter {
  private readonly connectionListeners = new Set<
    (state: ConnectionState) => void
  >();
  private currentQueue: AsyncQueue<DeltaPacket> | null = null;
  private connectionState: ConnectionState = "connected";
  private bootstrapCount = 0;

  readonly bootstrapCalls: BootstrapOptions[] = [];
  readonly subscribeCalls: SubscribeOptions[] = [];

  bootstrap(
    options: BootstrapOptions
  ): AsyncGenerator<ModelRow, BootstrapMetadata, unknown> {
    this.bootstrapCalls.push(options);
    this.bootstrapCount += 1;
    const isRecoveryBootstrap = this.bootstrapCount > 1;
    const rows: ModelRow[] = [
      {
        data: {
          id: "task-1",
          teamId: "team-1",
          title: isRecoveryBootstrap ? "Recovered" : "Initial",
        },
        modelName: "Task",
      },
    ];
    const metadata: BootstrapMetadata = {
      lastSyncId: isRecoveryBootstrap ? "25" : "10",
      subscribedSyncGroups: ["team-1"],
    };

    return (async function* generate() {
      await Promise.resolve();
      yield* rows;
      return metadata;
    })();
  }

  batchLoad(): AsyncGenerator<ModelRow, void, unknown> {
    return emptyBatchGenerator();
  }

  mutate(batch: TransactionBatch): Promise<MutateResult> {
    return Promise.resolve({
      lastSyncId: "25",
      results: batch.transactions.map((tx) => ({
        clientTxId: tx.clientTxId,
        success: true,
        syncId: "25",
      })),
      success: true,
    });
  }

  subscribe(options: SubscribeOptions): DeltaSubscription {
    this.subscribeCalls.push(options);

    if (this.subscribeCalls.length === 1) {
      const error = Object.assign(
        new Error("A fresh bootstrap is required before subscribing to deltas"),
        {
          code: "BOOTSTRAP_REQUIRED",
        }
      );
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(error),
          return: () =>
            Promise.resolve({
              done: true,
              value: undefined as unknown as DeltaPacket,
            }),
        }),
        unsubscribe: () => {
          /* noop */
        },
      };
    }

    const queue = new AsyncQueue<DeltaPacket>();
    this.currentQueue = queue;
    return {
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
      unsubscribe: () => queue.close(),
    };
  }

  fetchDeltas(after: string): Promise<DeltaPacket> {
    return Promise.resolve({ actions: [], lastSyncId: after });
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  onConnectionStateChange(
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback: (state: ConnectionState) => void
  ): () => void {
    this.connectionListeners.add(callback);
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback(this.connectionState);
    return () => {
      this.connectionListeners.delete(callback);
    };
  }

  close(): Promise<void> {
    this.currentQueue?.close();
    return Promise.resolve();
  }
}

class ResubscribeBootstrapRequiredTransport implements TransportAdapter {
  private readonly connectionListeners = new Set<
    (state: ConnectionState) => void
  >();
  private currentQueue: AsyncQueue<DeltaPacket> | null = null;
  private connectionState: ConnectionState = "connected";
  private bootstrapCount = 0;

  readonly bootstrapCalls: BootstrapOptions[] = [];
  readonly subscribeCalls: SubscribeOptions[] = [];

  bootstrap(
    options: BootstrapOptions
  ): AsyncGenerator<ModelRow, BootstrapMetadata, unknown> {
    this.bootstrapCalls.push(options);
    this.bootstrapCount += 1;
    const isRecoveryBootstrap = this.bootstrapCount > 1;
    const rows: ModelRow[] = isRecoveryBootstrap
      ? [
          {
            data: {
              id: "task-1",
              teamId: "team-1",
              title: "Recovered",
            },
            modelName: "Task",
          },
          {
            data: {
              id: "task-2",
              teamId: "team-1",
              title: "Local",
            },
            modelName: "Task",
          },
          {
            data: { id: "team-1", name: "Core" },
            modelName: "Team",
          },
        ]
      : [
          {
            data: {
              id: "task-1",
              teamId: "team-1",
              title: "Initial",
            },
            modelName: "Task",
          },
          {
            data: { id: "team-1", name: "Core" },
            modelName: "Team",
          },
        ];
    const metadata: BootstrapMetadata = {
      lastSyncId: isRecoveryBootstrap ? "25" : "10",
      subscribedSyncGroups: ["team-1"],
    };

    return (async function* generate() {
      await Promise.resolve();
      yield* rows;
      return metadata;
    })();
  }

  batchLoad(): AsyncGenerator<ModelRow, void, unknown> {
    return emptyBatchGenerator();
  }

  mutate(batch: TransactionBatch): Promise<MutateResult> {
    return Promise.resolve({
      lastSyncId: "25",
      results: batch.transactions.map((tx) => ({
        clientTxId: tx.clientTxId,
        success: true,
        syncId: "25",
      })),
      success: true,
    });
  }

  subscribe(options: SubscribeOptions): DeltaSubscription {
    this.subscribeCalls.push(options);

    if (this.subscribeCalls.length === 2) {
      const error = Object.assign(
        new Error("A fresh bootstrap is required before resubscribing"),
        {
          code: "BOOTSTRAP_REQUIRED",
        }
      );
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(error),
          return: () =>
            Promise.resolve({
              done: true,
              value: undefined as unknown as DeltaPacket,
            }),
        }),
        unsubscribe: () => {
          /* noop */
        },
      };
    }

    const queue = new AsyncQueue<DeltaPacket>();
    this.currentQueue = queue;
    return {
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
      unsubscribe: () => queue.close(),
    };
  }

  closeCurrentSubscription(): void {
    this.currentQueue?.close();
  }

  fetchDeltas(after: string): Promise<DeltaPacket> {
    return Promise.resolve({ actions: [], lastSyncId: after });
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  onConnectionStateChange(
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback: (state: ConnectionState) => void
  ): () => void {
    this.connectionListeners.add(callback);
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback(this.connectionState);
    return () => {
      this.connectionListeners.delete(callback);
    };
  }

  close(): Promise<void> {
    this.currentQueue?.close();
    return Promise.resolve();
  }
}

const schema: SchemaDefinition = {
  models: {
    Task: {
      fields: {
        id: {},
        teamId: {},
        title: {},
      },
      groupKey: "teamId",
      loadStrategy: "instant",
    },
    Team: {
      fields: {
        id: {},
        name: {},
      },
      loadStrategy: "instant",
    },
  },
};

const partialTaskSchema: SchemaDefinition = {
  models: {
    Task: {
      fields: {
        id: {},
        teamId: {},
        title: {},
      },
      groupKey: "teamId",
      loadStrategy: "partial",
    },
  },
};

const POLL_INTERVAL_MS = 5;
const SYNC_SETTLE_DELAY_MS = 20;
const WAIT_TIMEOUT_MS = 2000;

const sleep = async (ms: number): Promise<void> => {
  await delay(ms);
};

const waitUntil = async (
  condition: () => boolean | Promise<boolean>,
  errorMessage: string
): Promise<void> => {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(errorMessage);
};

const waitForSync = async (
  client: ReturnType<typeof createSyncClient>,
  expectedSyncId: string
): Promise<void> => {
  await waitUntil(
    () => client.lastSyncId === expectedSyncId,
    "Timed out waiting for sync completion"
  );
  await sleep(SYNC_SETTLE_DELAY_MS);
};

const waitForOutboxCount = async (
  client: ReturnType<typeof createSyncClient>,
  expectedCount: number
): Promise<void> => {
  // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for outbox count"));
    }, WAIT_TIMEOUT_MS);

    const unsubscribe = client.onEvent((event) => {
      if (
        event.type === "outboxChange" &&
        event.pendingCount === expectedCount
      ) {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  });
};

const waitForOutboxSize = async (
  storage: Pick<StorageAdapter, "getOutbox">,
  expectedCount: number
): Promise<void> => {
  await waitUntil(async () => {
    const outbox = await storage.getOutbox();
    return outbox.length === expectedCount;
  }, "Timed out waiting for outbox size");
};

const waitForSubscribeCount = async (
  transport: { subscribeCalls: unknown[] },
  expectedCount: number
): Promise<void> => {
  await waitUntil(
    () => transport.subscribeCalls.length >= expectedCount,
    "Timed out waiting for subscription restart"
  );
};

describe("reverse-done alignment", () => {
  it("does not surface a sync error if start is stopped before bootstrap fails", async () => {
    const storage = new InMemoryStorage();
    const bootstrapGate = createDeferred<undefined>();
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "1",
      },
      fullRows: [],
    });

    const originalBootstrap = transport.bootstrap.bind(transport);
    transport.bootstrap = ((options: BootstrapOptions) => {
      if (options.type !== "full") {
        return originalBootstrap(options);
      }

      // oxlint-disable-next-line require-yield -- intentionally throws before yielding to simulate bootstrap failure
      return (async function* generate() {
        await bootstrapGate.promise;
        throw new Error("bootstrap failed");
      })();
    }) as TestTransport["bootstrap"];

    const client = createSyncClient({
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    const syncErrors: string[] = [];
    const unsubscribe = client.onEvent((event) => {
      if (event.type === "syncError") {
        syncErrors.push(event.error.message);
      }
    });

    const startPromise = client.start();
    await Promise.resolve();
    await client.stop();
    bootstrapGate.resolve();

    await expect(startPromise).resolves.toBeUndefined();

    unsubscribe();
    expect(syncErrors).toEqual([]);
    expect(client.state).toBe("disconnected");
    expect(client.lastError).toBeNull();
  });

  it("bootstraps metadata and hydrates the object pool", async () => {
    const storage = new InMemoryStorage();
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "First" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new TestTransport({
      fullMetadata: {
        databaseVersion: 7,
        lastSyncId: "42",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
    });

    const client = createSyncClient({
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();

      expect(client.lastSyncId).toBe("42");
      const meta = (await storage.getMeta()) as {
        lastSyncId?: string;
        firstSyncId?: string;
        subscribedSyncGroups?: string[];
      };
      expect(meta.lastSyncId).toBe("42");
      expect(meta.firstSyncId).toBe("42");
      expect(meta.subscribedSyncGroups).toEqual(["team-1"]);

      const taskMap = client.getIdentityMap<Record<string, unknown>>("Task");
      expect(taskMap.get("task-1")).toMatchObject({
        id: "task-1",
        title: "First",
      });

      const persistence = await storage.getModelPersistence("Task");
      expect(persistence.persisted).toBeTruthy();

      expect(transport.bootstrapCalls[0]?.onlyModels).toEqual(["Task", "Team"]);
      expect(transport.fetchDeltaCalls[0]?.after).toBe("42");
    } finally {
      await client.stop();
    }
  });

  it("re-runs bootstrap when the delta subscription requires a fresh snapshot", async () => {
    const storage = new InMemoryStorage();
    await storage.addToOutbox({
      action: "U",
      clientId: "client-1",
      clientTxId: "persisted-awaiting-sync",
      createdAt: Date.now(),
      modelId: "task-1",
      modelName: "Task",
      original: { title: "Initial" },
      payload: { title: "Recovered" },
      retryCount: 0,
      state: "awaitingSync",
      syncIdNeededForCompletion: "25",
    });
    const transport = new BootstrapRequiredTransport();
    const client = createSyncClient({
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });
    const syncErrors: string[] = [];
    const unsubscribe = client.onEvent((event) => {
      if (event.type === "syncError") {
        syncErrors.push(event.error.message);
      }
    });

    try {
      await client.start();
      await waitForSync(client, "25");
      await waitForOutboxSize(storage, 0);

      expect(transport.bootstrapCalls).toHaveLength(2);
      expect(transport.subscribeCalls).toHaveLength(2);
      expect(syncErrors).toEqual([]);
      expect(await storage.getOutbox()).toHaveLength(0);
      expect(
        client.getIdentityMap<Record<string, unknown>>("Task").get("task-1")
      ).toMatchObject({
        id: "task-1",
        title: "Recovered",
      });
    } finally {
      unsubscribe();
      await client.stop();
    }
  });

  it("preserves outbox transactions across full bootstrap", async () => {
    const storage = new InMemoryStorage();
    await storage.addToOutbox({
      action: "I",
      clientId: "client-1",
      clientTxId: "persisted-failed-tx",
      createdAt: Date.now(),
      lastError: "network error",
      modelId: "task-failed",
      modelName: "Task",
      payload: { id: "task-failed", teamId: "team-1", title: "Failed" },
      retryCount: 5,
      state: "failed",
    });
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "First" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "42",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
    });

    const client = createSyncClient({
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();

      const outbox = await storage.getOutbox();
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.clientTxId).toBe("persisted-failed-tx");
    } finally {
      await client.stop();
    }
  });

  it("completes persisted awaitingSync transactions during startup when the sync cursor is already ahead", async () => {
    const storage = new InMemoryStorage();
    await storage.addToOutbox({
      action: "I",
      clientId: "client-1",
      clientTxId: "persisted-awaiting-sync",
      createdAt: Date.now(),
      modelId: "task-2",
      modelName: "Task",
      payload: {
        id: "task-2",
        teamId: "team-1",
        title: "Confirmed",
      },
      retryCount: 0,
      state: "awaitingSync",
      syncIdNeededForCompletion: "20",
    });
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "task-2", teamId: "team-1", title: "Confirmed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "25",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
    });

    const client = createSyncClient({
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();
      await waitForOutboxSize(storage, 0);

      expect(await storage.getOutbox()).toHaveLength(0);
      expect(
        client.getIdentityMap<Record<string, unknown>>("Task").get("task-2")
      ).toMatchObject({
        id: "task-2",
        title: "Confirmed",
      });
    } finally {
      await client.stop();
    }
  });

  it("completes awaitingSync transactions when a resubscribe requires a fresh snapshot", async () => {
    const storage = new InMemoryStorage();
    const transport = new ResubscribeBootstrapRequiredTransport();
    const client = createSyncClient({
      batchMutations: false,
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();

      await client.create("Task", {
        id: "task-2",
        teamId: "team-1",
        title: "Local",
      });

      const outboxBeforeRecovery = await storage.getOutbox();
      expect(outboxBeforeRecovery).toHaveLength(1);
      expect(outboxBeforeRecovery[0]?.state).toBe("awaitingSync");

      const syncWaiter = waitForSync(client, "25");
      transport.closeCurrentSubscription();
      await syncWaiter;
      await waitForOutboxSize(storage, 0);

      expect(transport.bootstrapCalls).toHaveLength(2);
      expect(transport.subscribeCalls).toHaveLength(3);
      expect(await storage.getOutbox()).toHaveLength(0);
      expect(
        client.getIdentityMap<Record<string, unknown>>("Task").get("task-2")
      ).toMatchObject({
        id: "task-2",
        title: "Local",
      });
    } finally {
      await client.stop();
    }
  });

  it("lazy loads partial models via indexed batch requests without duplicate fetches", async () => {
    const storage = new InMemoryStorage();
    const transport = new TestTransport({
      batchRows: [
        {
          data: { id: "task-1", teamId: "team-1", title: "Loaded" },
          modelName: "Task",
        },
      ],
      fullMetadata: {
        lastSyncId: "42",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: [],
    });

    const client = createSyncClient({
      reactivity: noopReactivityAdapter,
      schema: partialTaskSchema,
      storage,
      transport,
    });

    try {
      await client.start();

      const firstTask = await client.ensureModel<{
        id: string;
        title: string;
        teamId: string;
      }>("Task", "task-1");
      const secondTask = await client.ensureModel<{
        id: string;
        title: string;
        teamId: string;
      }>("Task", "task-1");

      expect(firstTask).toMatchObject({
        id: "task-1",
        teamId: "team-1",
        title: "Loaded",
      });
      expect(secondTask).toMatchObject({
        id: "task-1",
        teamId: "team-1",
        title: "Loaded",
      });
      expect(transport.batchLoadCalls).toEqual([
        {
          firstSyncId: "42",
          requests: [
            {
              indexedKey: "id",
              keyValue: "task-1",
              modelName: "Task",
            },
          ],
        },
      ]);
      expect(await storage.get("Task", "task-1")).toMatchObject({
        id: "task-1",
        teamId: "team-1",
        title: "Loaded",
      });
      expect(client.getCached("Task", "task-1")).toMatchObject({
        id: "task-1",
        teamId: "team-1",
        title: "Loaded",
      });
    } finally {
      await client.stop();
    }
  });

  it("applies post-subscribe catch-up deltas during startup", async () => {
    const storage = new InMemoryStorage();
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new TestTransport({
      fetchDeltaPacket: {
        actions: [
          {
            action: "U",
            data: { id: "task-1", teamId: "team-1", title: "Caught up" },
            id: "11",
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        lastSyncId: "11",
      },
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
    });

    const client = createSyncClient({
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();
      await waitForSync(client, "11");
      // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });

      expect(client.lastSyncId).toBe("11");
      expect(transport.fetchDeltaCalls[0]?.after).toBe("10");
      const taskMap = client.getIdentityMap<Record<string, unknown>>("Task");
      expect(taskMap.get("task-1")).toMatchObject({
        id: "task-1",
        teamId: "team-1",
        title: "Caught up",
      });
    } finally {
      await client.stop();
    }
  });

  it("pages catch-up fetches and preserves sync group scope", async () => {
    const storage = new InMemoryStorage();
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new TestTransport({
      fetchDeltaPackets: [
        {
          actions: [
            {
              action: "U",
              data: { id: "task-1", teamId: "team-1", title: "Page 1" },
              id: "11",
              modelId: "task-1",
              modelName: "Task",
            },
          ],
          hasMore: true,
          lastSyncId: "11",
        },
        {
          actions: [
            {
              action: "U",
              data: { id: "task-1", teamId: "team-1", title: "Page 2" },
              id: "12",
              modelId: "task-1",
              modelName: "Task",
            },
          ],
          lastSyncId: "12",
        },
      ],
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
    });

    const client = createSyncClient({
      groups: ["team-1"],
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();
      await waitForSync(client, "12");

      expect(transport.subscribeCalls[0]?.groups).toEqual(["team-1"]);
      expect(transport.fetchDeltaCalls).toEqual([
        { after: "10", groups: ["team-1"], limit: undefined },
        { after: "11", groups: ["team-1"], limit: undefined },
      ]);

      const taskMap = client.getIdentityMap<Record<string, unknown>>("Task");
      expect(taskMap.get("task-1")).toMatchObject({
        id: "task-1",
        teamId: "team-1",
        title: "Page 2",
      });
    } finally {
      await client.stop();
    }
  });

  it("does not fail startup when catch-up delta fetch fails", async () => {
    const storage = new InMemoryStorage();
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
    });

    transport.fetchDeltas = (
      _after: string,
      _limit?: number,
      _groups?: string[]
    ): Promise<DeltaPacket> => Promise.reject(new Error("network unavailable"));

    const client = createSyncClient({
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();

      expect(client.lastSyncId).toBe("10");
      const taskMap = client.getIdentityMap<Record<string, unknown>>("Task");
      expect(taskMap.get("task-1")).toMatchObject({
        id: "task-1",
        title: "Seed",
      });
    } finally {
      await client.stop();
    }
  });

  it("does not block startup when catch-up fetch hangs", async () => {
    const storage = new InMemoryStorage();
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
    });

    transport.fetchDeltas = (
      _after: string,
      _limit?: number,
      _groups?: string[]
    ) =>
      // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
      new Promise<DeltaPacket>(() => {
        // Never resolves
      });

    const client = createSyncClient({
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await Promise.race([
        client.start(),
        // oxlint-disable-next-line avoid-new, param-names -- wrapping callback API in promise; only reject used
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error("start blocked"));
          }, 200);
        }),
      ]);

      expect(client.state).toBe("syncing");
    } finally {
      await client.stop();
    }
  });

  it("clearAll resets runtime cursors and queued state", async () => {
    const storage = new InMemoryStorage();
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "42",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
    });

    const client = createSyncClient({
      batchDelay: 1000,
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();
      await client.create("Task", {
        id: "task-2",
        teamId: "team-1",
        title: "Queued",
      });

      await client.clearAll();

      expect(client.lastSyncId).toBe("0");
      expect(client.state).toBe("disconnected");
      expect(client.connectionState).toBe("disconnected");
      expect(await storage.getOutbox()).toHaveLength(0);
      expect(await storage.getAll("Task")).toHaveLength(0);
      expect(client.getIdentityMap<Record<string, unknown>>("Task").size).toBe(
        0
      );

      const meta = await storage.getMeta();
      expect(meta.lastSyncId).toBe("0");

      await client.start();
      expect(client.lastSyncId).toBe("42");
    } finally {
      await client.stop();
    }
  });

  it("does not regress sync cursor when delayed catch-up returns older deltas", async () => {
    const storage = new InMemoryStorage();
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
    });

    let resolveCatchUp: ((packet: DeltaPacket) => void) | null = null;
    transport.fetchDeltas = (
      _after: string,
      _limit?: number,
      _groups?: string[]
    ) =>
      // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
      new Promise<DeltaPacket>((resolve) => {
        resolveCatchUp = resolve;
      });

    const client = createSyncClient({
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();

      const streamPacket: DeltaPacket = {
        actions: [
          {
            action: "U",
            data: { id: "task-1", teamId: "team-1", title: "From stream" },
            id: "12",
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        lastSyncId: "12",
      };
      const streamSyncWaiter = waitForSync(client, "12");
      transport.emitDelta(streamPacket);
      await streamSyncWaiter;

      if (!resolveCatchUp) {
        throw new Error("Catch-up fetch did not start");
      }
      resolveCatchUp({
        actions: [
          {
            action: "U",
            data: { id: "task-1", teamId: "team-1", title: "From catch-up" },
            id: "11",
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        lastSyncId: "11",
      });

      // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });

      expect(client.lastSyncId).toBe("12");
      const taskMap = client.getIdentityMap<Record<string, unknown>>("Task");
      expect(taskMap.get("task-1")).toMatchObject({
        id: "task-1",
        title: "From stream",
      });
    } finally {
      await client.stop();
    }
  });

  it("serializes overlapping catch-up and stream packets to avoid stale overwrites", async () => {
    const storage = new BlockingSyncActionStorage("11");
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new TestTransport({
      fetchDeltaPacket: {
        actions: [
          {
            action: "U",
            data: { id: "task-1", teamId: "team-1", title: "From catch-up" },
            id: "11",
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        lastSyncId: "11",
      },
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
    });

    const client = createSyncClient({
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();
      await storage.waitUntilBlocked();

      const streamSyncWaiter = waitForSync(client, "12");
      transport.emitDelta({
        actions: [
          {
            action: "U",
            data: { id: "task-1", teamId: "team-1", title: "From stream" },
            id: "12",
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        lastSyncId: "12",
      });

      // Stream packet should wait while catch-up apply is still in-flight.
      // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(client.lastSyncId).toBe("10");

      storage.unblock();
      await streamSyncWaiter;
      // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });

      expect(client.lastSyncId).toBe("12");
      const taskMap = client.getIdentityMap<Record<string, unknown>>("Task");
      expect(taskMap.get("task-1")).toMatchObject({
        id: "task-1",
        title: "From stream",
      });
    } finally {
      storage.unblock();
      await client.stop();
    }
  });

  it("serializes local mutations behind in-flight delta application", async () => {
    const storage = new BlockingSyncActionStorage("11");
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
    });

    const client = createSyncClient({
      batchMutations: false,
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();

      const syncWaiter = waitForSync(client, "11");
      transport.emitDelta({
        actions: [
          {
            action: "U",
            data: { title: "From delta" },
            id: "11",
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        lastSyncId: "11",
      });

      await storage.waitUntilBlocked();

      let mutationSettled = false;
      const mutationPromise = client
        .update("Task", "task-1", { description: "Local change" })
        .then(() => {
          mutationSettled = true;
        });

      await Promise.resolve();
      await Promise.resolve();
      expect(mutationSettled).toBeFalsy();

      storage.unblock();
      await Promise.all([syncWaiter, mutationPromise]);

      const taskMap = client.getIdentityMap<Record<string, unknown>>("Task");
      expect(taskMap.get("task-1")).toMatchObject({
        description: "Local change",
        id: "task-1",
        teamId: "team-1",
        title: "From delta",
      });
    } finally {
      storage.unblock();
      await client.stop();
    }
  });

  it("ignores stale catch-up results from a previous run after stop/start", async () => {
    const storage = new InMemoryStorage();
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
    });

    let resolveFirstCatchUp: ((packet: DeltaPacket) => void) | null = null;
    let fetchCallCount = 0;
    transport.fetchDeltas = (
      _after: string,
      _limit?: number,
      _groups?: string[]
    ) => {
      fetchCallCount += 1;
      if (fetchCallCount === 1) {
        // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
        return new Promise<DeltaPacket>((resolve) => {
          resolveFirstCatchUp = resolve;
        });
      }
      return Promise.resolve({ actions: [], lastSyncId: "10" });
    };

    const client = createSyncClient({
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();
      await client.stop();
      await client.start();

      if (!resolveFirstCatchUp) {
        throw new Error("First catch-up fetch did not start");
      }
      resolveFirstCatchUp({
        actions: [
          {
            action: "U",
            data: { id: "task-1", teamId: "team-1", title: "Old run packet" },
            id: "11",
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        lastSyncId: "11",
      });

      // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });

      expect(client.lastSyncId).toBe("10");
      const taskMap = client.getIdentityMap<Record<string, unknown>>("Task");
      expect(taskMap.get("task-1")).toMatchObject({
        id: "task-1",
        title: "Seed",
      });
    } finally {
      await client.stop();
    }
  });

  it("skips no-op updates without outbox or history side effects", async () => {
    const storage = new InMemoryStorage();
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
    });

    const client = createSyncClient({
      batchMutations: false,
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();
      await waitForSync(client, "10");

      const initialOutbox = await storage.getOutbox();
      expect(initialOutbox).toHaveLength(0);
      expect(client.canUndo()).toBeFalsy();
      expect(client.canRedo()).toBeFalsy();

      const sideEffectEvents: ("modelChange" | "outboxChange")[] = [];
      const unsubscribe = client.onEvent((event) => {
        if (event.type === "modelChange" || event.type === "outboxChange") {
          sideEffectEvents.push(event.type);
        }
      });

      let createdTx: Transaction | null = null;
      const updated = await client.update(
        "Task",
        "task-1",
        { title: "Seed" },
        {
          onTransactionCreated: (tx) => {
            createdTx = tx;
          },
        }
      );
      unsubscribe();

      expect(updated).toMatchObject({
        id: "task-1",
        teamId: "team-1",
        title: "Seed",
      });
      expect(createdTx).toBeNull();
      expect(client.canUndo()).toBeFalsy();
      expect(client.canRedo()).toBeFalsy();
      expect(sideEffectEvents).toEqual([]);
      expect(await storage.getOutbox()).toHaveLength(0);
      expect(await client.getPendingCount()).toBe(0);

      const taskMap = client.getIdentityMap<Record<string, unknown>>("Task");
      expect(taskMap.get("task-1")).toMatchObject({
        id: "task-1",
        teamId: "team-1",
        title: "Seed",
      });
    } finally {
      await client.stop();
    }
  });

  it("serializes optimistic mutation payloads while keeping model values raw", async () => {
    const serializer = {
      deserialize(value: unknown): { deep: { count: number } } {
        if (typeof value !== "string") {
          throw new TypeError(
            `expected serialized string, got ${typeof value}`
          );
        }
        return JSON.parse(value) as { deep: { count: number } };
      },
      serialize(value: unknown): unknown {
        return JSON.stringify(value);
      },
    };

    class SerializedTask extends Model {
      declare payload: { deep: { count: number } };
    }

    Property({ serializer })(SerializedTask.prototype, "payload");
    ClientModel("SerializedTaskMutation")(SerializedTask);

    const serializedSchema: SchemaDefinition = {
      models: {
        SerializedTaskMutation: {
          fields: {
            id: {},
            payload: { serializer },
          },
          loadStrategy: "instant",
        },
      },
    };

    const storage = new InMemoryStorage();
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
      },
      fullRows: [],
    });

    const client = createSyncClient({
      batchMutations: false,
      reactivity: noopReactivityAdapter,
      schema: serializedSchema,
      storage,
      transport,
    });

    try {
      await client.start();

      const created = await client.create("SerializedTaskMutation", {
        id: "task-1",
        payload: { deep: { count: 1 } },
      });

      expect(created).toMatchObject({
        id: "task-1",
        payload: { deep: { count: 1 } },
      });

      let outbox = await storage.getOutbox();
      expect(outbox[0]?.payload).toMatchObject({
        id: "task-1",
        payload: JSON.stringify({ deep: { count: 1 } }),
      });

      const taskMap = client.getIdentityMap<SerializedTask>(
        "SerializedTaskMutation"
      );
      expect(taskMap.get("task-1")?.payload).toEqual({
        deep: { count: 1 },
      });

      const updated = await client.update("SerializedTaskMutation", "task-1", {
        payload: { deep: { count: 2 } },
      });

      expect(updated).toMatchObject({
        id: "task-1",
        payload: { deep: { count: 2 } },
      });

      outbox = await storage.getOutbox();
      expect(outbox[1]?.payload).toEqual({
        payload: JSON.stringify({ deep: { count: 2 } }),
      });
      expect(outbox[1]?.original).toEqual({
        payload: JSON.stringify({ deep: { count: 1 } }),
      });
      expect(taskMap.get("task-1")?.payload).toEqual({
        deep: { count: 2 },
      });
    } finally {
      await client.stop();
    }
  });

  it("materializes serializer-backed mutation results when optimistic updates are disabled", async () => {
    const serializer = {
      deserialize(value: unknown): { deep: { count: number } } {
        if (typeof value !== "string") {
          throw new TypeError(
            `expected serialized string, got ${typeof value}`
          );
        }
        return JSON.parse(value) as { deep: { count: number } };
      },
      serialize(value: unknown): unknown {
        return JSON.stringify(value);
      },
    };

    class NonOptimisticSerializedTask extends Model {
      declare payload: { deep: { count: number } };
    }

    Property({ serializer })(NonOptimisticSerializedTask.prototype, "payload");
    ClientModel("NonOptimisticSerializedTask")(NonOptimisticSerializedTask);

    const serializedSchema: SchemaDefinition = {
      models: {
        NonOptimisticSerializedTask: {
          fields: {
            id: {},
            payload: { serializer },
          },
          loadStrategy: "instant",
        },
      },
    };

    const storage = new InMemoryStorage();
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
      },
      fullRows: [
        {
          data: {
            id: "task-1",
            payload: JSON.stringify({ deep: { count: 1 } }),
          },
          modelName: "NonOptimisticSerializedTask",
        },
      ],
    });

    const client = createSyncClient({
      batchMutations: false,
      optimistic: false,
      reactivity: noopReactivityAdapter,
      schema: serializedSchema,
      storage,
      transport,
    });

    try {
      await client.start();

      const updated = await client.update(
        "NonOptimisticSerializedTask",
        "task-1",
        {
          payload: { deep: { count: 2 } },
        }
      );

      expect(updated).toMatchObject({
        id: "task-1",
        payload: { deep: { count: 2 } },
      });

      const outbox = await storage.getOutbox();
      expect(outbox[0]?.payload).toEqual({
        payload: JSON.stringify({ deep: { count: 2 } }),
      });
      expect(outbox[0]?.original).toEqual({
        payload: JSON.stringify({ deep: { count: 1 } }),
      });
    } finally {
      await client.stop();
    }
  });

  it("deserializes schema-only serializer fields from bootstrap rows", async () => {
    const serializer = {
      deserialize(value: unknown): { deep: { count: number } } {
        if (typeof value !== "string") {
          throw new TypeError(
            `expected serialized string, got ${typeof value}`
          );
        }
        return JSON.parse(value) as { deep: { count: number } };
      },
      serialize(value: unknown): unknown {
        return JSON.stringify(value);
      },
    };

    const serializedSchema: SchemaDefinition = {
      models: {
        SchemaSerializedTask: {
          fields: {
            id: {},
            payload: { serializer },
          },
          loadStrategy: "instant",
        },
      },
    };
    const storage = new InMemoryStorage();
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
      },
      fullRows: [
        {
          data: {
            id: "task-1",
            payload: JSON.stringify({ deep: { count: 1 } }),
          },
          modelName: "SchemaSerializedTask",
        },
      ],
    });

    const client = createSyncClient({
      reactivity: noopReactivityAdapter,
      schema: serializedSchema,
      storage,
      transport,
    });

    try {
      await client.start();

      expect(client.getCached("SchemaSerializedTask", "task-1")).toEqual({
        id: "task-1",
        payload: { deep: { count: 1 } },
      });
    } finally {
      await client.stop();
    }
  });

  it("captures grouped UI operations as a single undo step", async () => {
    const storage = new InMemoryStorage();
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
    });

    const client = createSyncClient({
      batchMutations: false,
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();

      await client.runAsUndoGroup(async () => {
        await client.update("Task", "task-1", { title: "Renamed" });
        await client.update("Team", "team-1", { name: "Platform" });
      });

      const taskMap = client.getIdentityMap<Record<string, unknown>>("Task");
      const teamMap = client.getIdentityMap<Record<string, unknown>>("Team");

      expect(taskMap.get("task-1")).toMatchObject({
        id: "task-1",
        teamId: "team-1",
        title: "Renamed",
      });
      expect(teamMap.get("team-1")).toMatchObject({
        id: "team-1",
        name: "Platform",
      });
      expect(client.canUndo()).toBeTruthy();
      expect(client.canRedo()).toBeFalsy();

      await client.undo();

      expect(taskMap.get("task-1")).toMatchObject({
        id: "task-1",
        teamId: "team-1",
        title: "Seed",
      });
      expect(teamMap.get("team-1")).toMatchObject({
        id: "team-1",
        name: "Core",
      });
      expect(client.canUndo()).toBeFalsy();
      expect(client.canRedo()).toBeTruthy();

      await client.redo();

      expect(taskMap.get("task-1")).toMatchObject({
        id: "task-1",
        teamId: "team-1",
        title: "Renamed",
      });
      expect(teamMap.get("team-1")).toMatchObject({
        id: "team-1",
        name: "Platform",
      });
      expect(client.canUndo()).toBeTruthy();
      expect(client.canRedo()).toBeFalsy();
    } finally {
      await client.stop();
    }
  });

  it("applies remote updates in the same packet as a confirmed local echo", async () => {
    const storage = new InMemoryStorage();
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
    });

    const client = createSyncClient({
      batchMutations: false,
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();

      const events: string[] = [];
      const unsubscribe = client.onEvent((event) => {
        if (event.type === "modelChange") {
          events.push(`${event.modelId}:${event.action}`);
        }
      });

      await client.update("Task", "task-1", { title: "Local" });
      const outbox = await storage.getOutbox();
      const localTxId = outbox[0]?.clientTxId;
      if (!localTxId) {
        throw new Error("Expected local tx id");
      }

      const syncWaiter = waitForSync(client, "12");
      transport.emitDelta({
        actions: [
          {
            action: "U",
            clientId: client.clientId,
            clientTxId: localTxId,
            data: { title: "Local" },
            id: "11",
            modelId: "task-1",
            modelName: "Task",
          },
          {
            action: "U",
            clientId: "remote-client",
            clientTxId: "remote-tx",
            data: { description: "Remote detail" },
            id: "12",
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        lastSyncId: "12",
      });
      await syncWaiter;
      unsubscribe();

      const taskMap = client.getIdentityMap<Record<string, unknown>>("Task");
      expect(taskMap.get("task-1")).toMatchObject({
        description: "Remote detail",
        id: "task-1",
        teamId: "team-1",
        title: "Local",
      });
      expect(events.filter((event) => event === "task-1:update")).toHaveLength(
        2
      );
    } finally {
      await client.stop();
    }
  });

  it("applies delta packets and clears confirmed outbox transactions", async () => {
    const storage = new InMemoryStorage();
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
      startingSyncId: 50,
    });

    const client = createSyncClient({
      batchMutations: false,
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();

      let createdTx: Transaction | null = null;
      const created = await client.create(
        "Task",
        { id: "task-2", teamId: "team-1", title: "New" },
        {
          onTransactionCreated: (tx) => {
            createdTx = tx;
          },
        }
      );

      expect(createdTx).not.toBeNull();
      const outbox = await storage.getOutbox();
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.state).toBe("awaitingSync");

      const syncId = outbox[0]?.syncIdNeededForCompletion ?? "51";
      const delta: DeltaPacket = {
        actions: [
          {
            action: "I",
            clientTxId: createdTx?.clientTxId,
            data: created,
            id: syncId,
            modelId: "task-2",
            modelName: "Task",
          },
        ],
        lastSyncId: syncId,
      };

      const syncWaiter = waitForSync(client, syncId);
      const outboxWaiter = waitForOutboxCount(client, 0);
      transport.emitDelta(delta);
      await Promise.all([syncWaiter, outboxWaiter]);

      const clearedOutbox = await storage.getOutbox();
      expect(clearedOutbox).toHaveLength(0);

      const taskMap = client.getIdentityMap<Record<string, unknown>>("Task");
      expect(taskMap.get("task-2")).toMatchObject({
        id: "task-2",
        title: "New",
      });
    } finally {
      await client.stop();
    }
  });

  it("does not clear a later insert with the same model ID when confirming an earlier create", async () => {
    const storage = new InMemoryStorage();
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
      startingSyncId: 50,
    });

    const client = createSyncClient({
      batchMutations: false,
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();

      const firstTx: Transaction = {
        action: "I",
        clientId: client.clientId,
        clientTxId: "first-create",
        createdAt: Date.now(),
        modelId: "task-2",
        modelName: "Task",
        payload: {
          id: "task-2",
          teamId: "team-1",
          title: "First",
        },
        retryCount: 5,
        state: "failed",
      };
      const secondTx: Transaction = {
        action: "I",
        clientId: client.clientId,
        clientTxId: "second-create",
        createdAt: Date.now(),
        modelId: "task-2",
        modelName: "Task",
        payload: {
          id: "task-2",
          teamId: "team-1",
          title: "Second",
        },
        retryCount: 5,
        state: "failed",
      };
      await storage.addToOutbox(firstTx);
      await storage.addToOutbox(secondTx);

      const syncWaiter = waitForSync(client, "51");
      transport.emitDelta({
        actions: [
          {
            action: "I",
            clientTxId: firstTx.clientTxId,
            data: {
              id: "task-2",
              teamId: "team-1",
              title: "First",
            },
            id: "51",
            modelId: "task-2",
            modelName: "Task",
          },
        ],
        lastSyncId: "51",
      });
      await syncWaiter;
      await waitForOutboxSize(storage, 1);

      const outboxAfter = await storage.getOutbox();
      expect(outboxAfter).toHaveLength(1);
      expect(outboxAfter[0]?.clientTxId).toBe(secondTx.clientTxId);
    } finally {
      await client.stop();
    }
  });

  it("completes awaiting outbox transactions when a packet only advances sync cursor", async () => {
    const storage = new InMemoryStorage();
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
      startingSyncId: 50,
    });

    const client = createSyncClient({
      batchMutations: false,
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();

      await client.create("Task", {
        id: "task-2",
        teamId: "team-1",
        title: "New",
      });

      const outbox = await storage.getOutbox();
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.state).toBe("awaitingSync");
      const syncId = outbox[0]?.syncIdNeededForCompletion ?? "51";

      const syncWaiter = waitForSync(client, syncId);
      const outboxWaiter = waitForOutboxCount(client, 0);
      transport.emitDelta({
        actions: [],
        lastSyncId: syncId,
      });
      await Promise.all([syncWaiter, outboxWaiter]);

      expect(await storage.getOutbox()).toHaveLength(0);
    } finally {
      await client.stop();
    }
  });

  it("completes only awaiting transactions up to the sync cursor for empty packets", async () => {
    const storage = new InMemoryStorage();
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
      startingSyncId: 50,
    });

    const client = createSyncClient({
      batchMutations: false,
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();

      await client.create("Task", {
        id: "task-2",
        teamId: "team-1",
        title: "Second",
      });
      await client.create("Task", {
        id: "task-3",
        teamId: "team-1",
        title: "Third",
      });

      const outbox = await storage.getOutbox();
      expect(outbox).toHaveLength(2);

      const firstSyncId = outbox[0]?.syncIdNeededForCompletion;
      const secondSyncId = outbox[1]?.syncIdNeededForCompletion;
      expectTypeOf(firstSyncId).toBeString();
      expectTypeOf(secondSyncId).toBeString();

      if (!(firstSyncId && secondSyncId)) {
        throw new Error("Expected awaiting sync IDs for both transactions");
      }

      const syncWaiter = waitForSync(client, firstSyncId);
      const outboxWaiter = waitForOutboxCount(client, 1);
      transport.emitDelta({
        actions: [],
        lastSyncId: firstSyncId,
      });
      await Promise.all([syncWaiter, outboxWaiter]);

      const remainingOutbox = await storage.getOutbox();
      expect(remainingOutbox).toHaveLength(1);
      expect(remainingOutbox[0]?.syncIdNeededForCompletion).toBe(secondSyncId);
    } finally {
      await client.stop();
    }
  });

  it("applies empty sync-group updates and clears the previous group scope", async () => {
    const storage = new InMemoryStorage();
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
    });

    const client = createSyncClient({
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();

      transport.emitDelta({
        actions: [
          {
            action: "S",
            data: { subscribedSyncGroups: [] },
            id: "60",
            modelId: "sync-groups",
            modelName: "SyncGroup",
          },
        ],
        lastSyncId: "60",
      });
      await waitForSubscribeCount(transport, 2);
      await sleep(SYNC_SETTLE_DELAY_MS);

      const meta = (await storage.getMeta()) as {
        firstSyncId?: string;
        subscribedSyncGroups?: string[];
      };
      expect(meta.firstSyncId).toBe("60");
      expect(meta.subscribedSyncGroups).toEqual([]);
      expect(transport.subscribeCalls).toHaveLength(2);
      expect(transport.subscribeCalls.at(-1)?.groups).toEqual([]);

      const taskMap = client.getIdentityMap<Record<string, unknown>>("Task");
      expect(taskMap.get("task-1")).toBeUndefined();
      expect(await storage.get("Task", "task-1")).toBeNull();
    } finally {
      await client.stop();
    }
  });

  it("re-subscribes live deltas after a clean close and reconnect", async () => {
    const storage = new InMemoryStorage();
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new ReconnectableTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
    });

    const client = createSyncClient({
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();

      transport.setConnectionState("disconnected");
      transport.closeCurrentSubscription();
      await Promise.resolve();
      transport.setConnectionState("connected");
      await waitForSubscribeCount(transport, 2);

      const syncWaiter = waitForSync(client, "11");
      transport.emitDelta({
        actions: [
          {
            action: "U",
            clientId: "remote-client",
            data: { title: "Remote" },
            id: "11",
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        lastSyncId: "11",
      });
      await syncWaiter;

      const taskMap = client.getIdentityMap<Record<string, unknown>>("Task");
      expect(taskMap.get("task-1")).toMatchObject({
        id: "task-1",
        title: "Remote",
      });
    } finally {
      await client.stop();
    }
  });

  it("tears down transport connection listeners on stop and rebinds once on restart", async () => {
    const storage = new InMemoryStorage();
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new ReconnectableTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
    });

    const client = createSyncClient({
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    const observedStates: ConnectionState[] = [];
    client.onConnectionStateChange((state) => {
      observedStates.push(state);
    });

    try {
      expect(transport.getConnectionListenerCount()).toBe(1);

      await client.start();
      expect(transport.getConnectionListenerCount()).toBe(1);

      await client.stop();
      expect(transport.getConnectionListenerCount()).toBe(0);

      const eventCountAfterStop = observedStates.length;
      transport.setConnectionState("disconnected");
      transport.setConnectionState("connected");
      await Promise.resolve();

      expect(observedStates).toHaveLength(eventCountAfterStop);
      expect(client.connectionState).toBe("disconnected");

      await client.start();
      expect(transport.getConnectionListenerCount()).toBe(1);
    } finally {
      await client.stop();
    }
  });

  it("cancels partial sync-group bootstrap when stopped mid-stream", async () => {
    const storage = new InMemoryStorage();
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
    });
    const resumePartial = createDeferred<undefined>();
    const partialReady = createDeferred<undefined>();
    const originalBootstrap = transport.bootstrap.bind(transport);
    transport.bootstrap = ((options: BootstrapOptions) => {
      if (options.type !== "partial") {
        return originalBootstrap(options);
      }

      return (async function* generate() {
        yield {
          data: { id: "task-2", teamId: "team-2", title: "Team 2" },
          modelName: "Task",
        };
        partialReady.resolve();
        await resumePartial.promise;
        yield {
          data: { id: "task-3", teamId: "team-2", title: "Team 2 later" },
          modelName: "Task",
        };
      })();
    }) as TestTransport["bootstrap"];

    const client = createSyncClient({
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();

      transport.emitDelta({
        actions: [
          {
            action: "S",
            data: { subscribedSyncGroups: ["team-1", "team-2"] },
            id: "60",
            modelId: "sync-groups",
            modelName: "SyncGroup",
          },
        ],
        lastSyncId: "60",
      });

      await partialReady.promise;
      const stopPromise = client.stop();
      resumePartial.resolve();
      await stopPromise;

      expect(await storage.get("Task", "task-2")).toMatchObject({
        id: "task-2",
        teamId: "team-2",
        title: "Team 2",
      });
      expect(await storage.get("Task", "task-3")).toBeNull();
    } finally {
      await client.stop();
    }
  });

  it("keeps pending tx targets alive during delta batch eviction", async () => {
    const storage = new InMemoryStorage();
    const rows: ModelRow[] = [
      {
        data: { id: "task-0", teamId: "team-1", title: "Zero" },
        modelName: "Task",
      },
      {
        data: { id: "task-1", teamId: "team-1", title: "One" },
        modelName: "Task",
      },
    ];
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
      startingSyncId: 50,
    });

    const client = createSyncClient({
      batchMutations: false,
      identityMapMaxSize: 2,
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();

      await client.update("Task", "task-1", { title: "Updated" });
      client.getCached("Task", "task-0");

      const task1Before = client
        .getIdentityMap<Record<string, unknown>>("Task")
        .get("task-1");
      if (!task1Before) {
        throw new Error("Expected task-1 to be cached before delta");
      }

      const syncWaiter = waitForSync(client, "11");
      transport.emitDelta({
        actions: [
          {
            action: "I",
            clientId: "remote-client",
            data: {
              id: "task-2",
              teamId: "team-1",
              title: "Two",
            },
            id: "11",
            modelId: "task-2",
            modelName: "Task",
          },
        ],
        lastSyncId: "11",
      });
      await syncWaiter;

      const task1After = client.getCached<Record<string, unknown>>(
        "Task",
        "task-1"
      );
      expect(task1After).toBe(task1Before);
    } finally {
      await client.stop();
    }
  });

  it("does not recreate missing models from partial pending replays", async () => {
    const storage = new InMemoryStorage();
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: [],
    });
    const identityMaps = new IdentityMapRegistry(noopReactivityAdapter);
    const orchestrator = new SyncOrchestrator(
      {
        reactivity: noopReactivityAdapter,
        schema,
        storage,
        transport,
      },
      identityMaps
    );
    const replayPending = (
      orchestrator as unknown as {
        applyPendingTransactionsToIdentityMaps(pending: Transaction[]): void;
      }
    ).applyPendingTransactionsToIdentityMaps.bind(orchestrator);

    try {
      replayPending([
        {
          action: "U",
          clientId: "client-1",
          clientTxId: "tx-update",
          createdAt: Date.now(),
          modelId: "task-1",
          modelName: "Task",
          original: { title: "Seed" },
          payload: { title: "Local only" },
          retryCount: 0,
          state: "queued",
        },
        {
          action: "A",
          clientId: "client-1",
          clientTxId: "tx-archive",
          createdAt: Date.now(),
          modelId: "task-2",
          modelName: "Task",
          original: { archivedAt: null },
          payload: { archivedAt: Date.now() },
          retryCount: 0,
          state: "queued",
        },
      ]);

      const taskMap = identityMaps.getMap<Record<string, unknown>>("Task");
      expect(taskMap.get("task-1")).toBeUndefined();
      expect(taskMap.get("task-2")).toBeUndefined();
    } finally {
      await orchestrator.reset();
    }
  });

  it("applies same-clientId deltas from another tab", async () => {
    const storage = new InMemoryStorage();
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
    });

    const client = createSyncClient({
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();

      const modelChangeEvents: string[] = [];
      // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
      const modelChangeWaiter = new Promise<void>((resolve) => {
        const unsubscribe = client.onEvent((event) => {
          if (
            event.type === "modelChange" &&
            event.modelName === "Task" &&
            event.modelId === "task-1"
          ) {
            modelChangeEvents.push(event.action);
            unsubscribe();
            resolve();
          }
        });
      });

      const delta: DeltaPacket = {
        actions: [
          {
            action: "U",
            // Simulate another browser tab that shares logical clientId.
            clientId: client.clientId,
            clientTxId: "other-tab-tx",
            data: {
              id: "task-1",
              teamId: "team-1",
              title: "Remote tab edit",
            },
            id: "11",
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        lastSyncId: "11",
      };

      const syncWaiter = waitForSync(client, "11");
      transport.emitDelta(delta);
      await Promise.all([syncWaiter, modelChangeWaiter]);

      const taskMap = client.getIdentityMap<Record<string, unknown>>("Task");
      expect(taskMap.get("task-1")).toMatchObject({
        id: "task-1",
        title: "Remote tab edit",
      });
      expect(modelChangeEvents).toContain("update");
    } finally {
      await client.stop();
    }
  });

  it("sync-group deltas trigger partial bootstrap for new groups", async () => {
    const storage = new InMemoryStorage();
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];
    const partialRows = new Map<string, ModelRow[]>([
      [
        "team-2",
        [
          {
            data: { id: "task-2", teamId: "team-2", title: "Team 2" },
            modelName: "Task",
          },
        ],
      ],
    ]);
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
      partialRowsByGroup: partialRows,
    });

    const client = createSyncClient({
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();

      const delta: DeltaPacket = {
        actions: [
          {
            action: "S",
            data: { subscribedSyncGroups: ["team-1", "team-2"] },
            id: "60",
            modelId: "sync-groups",
            modelName: "SyncGroup",
          },
        ],
        lastSyncId: "60",
      };

      const syncWaiter = waitForSync(client, "60");
      transport.emitDelta(delta);
      await syncWaiter;

      const meta = (await storage.getMeta()) as {
        firstSyncId?: string;
        subscribedSyncGroups?: string[];
      };
      expect(meta.firstSyncId).toBe("60");
      expect(meta.subscribedSyncGroups).toEqual(["team-1", "team-2"]);

      const taskMap = client.getIdentityMap<Record<string, unknown>>("Task");
      expect(taskMap.get("task-2")).toMatchObject({
        id: "task-2",
        teamId: "team-2",
      });

      const partialCall = transport.bootstrapCalls.find(
        (call) => call.type === "partial"
      );
      expect(partialCall?.syncGroups).toEqual(["team-2"]);
      expect(transport.subscribeCalls.length).toBeGreaterThanOrEqual(2);
      const latestSubscribe = transport.subscribeCalls.at(-1);
      expect(latestSubscribe?.groups).toEqual(["team-1", "team-2"]);
      expect(latestSubscribe?.afterSyncId).toBe("60");
    } finally {
      await client.stop();
    }
  });

  it("does not synthesize partial models from pending updates without a base row", async () => {
    const storage = new InMemoryStorage();
    await storage.addToOutbox({
      action: "U",
      clientId: "client-1",
      clientTxId: "tx-1",
      createdAt: Date.now(),
      modelId: "task-1",
      modelName: "Task",
      original: { title: "Seed" },
      payload: { title: "Local only" },
      retryCount: 0,
      state: "queued",
    });
    const transport = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: [],
      },
      fullRows: [],
    });

    const client = createSyncClient({
      batchMutations: false,
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();
      await sleep(SYNC_SETTLE_DELAY_MS);

      expect(client.getCached("Task", "task-1")).toBeNull();
      expect(await storage.get("Task", "task-1")).toBeNull();
    } finally {
      await client.stop();
    }
  });

  it("re-attaches the transport listener across stop/start without dropping public listeners", async () => {
    const storage = new InMemoryStorage();
    const transport = new ReconnectableTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: [],
      },
      fullRows: [],
    });
    const client = createSyncClient({
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });
    const connectionStates: ConnectionState[] = [];
    const unsubscribe = client.onConnectionStateChange((state) => {
      connectionStates.push(state);
    });

    try {
      expect(transport.getConnectionListenerCount()).toBe(1);

      await client.start();
      expect(transport.getConnectionListenerCount()).toBe(1);

      await client.stop();
      expect(transport.getConnectionListenerCount()).toBe(0);

      await client.start();
      expect(transport.getConnectionListenerCount()).toBe(1);

      transport.setConnectionState("disconnected");
      transport.setConnectionState("connected");
      await sleep(SYNC_SETTLE_DELAY_MS);

      expect(client.connectionState).toBe("connected");
      expect(connectionStates).toContain("disconnected");
      expect(connectionStates).toContain("connected");
    } finally {
      unsubscribe();
      await client.stop();
    }
  });

  it("returns canonical model instances when a plain modelFactory is configured", async () => {
    class TaskModel {
      kind: string;
      id = "";
      title = "";

      constructor(modelName: string, data: Record<string, unknown> = {}) {
        this.kind = modelName;
        Object.assign(this, data);
      }
    }

    type TaskInstance = Record<string, unknown> & TaskModel;

    const modelFactorySchema: SchemaDefinition = {
      models: {
        Task: {
          fields: {
            id: {},
            title: {},
          },
          loadStrategy: "partial",
        },
      },
    };
    const storage = new InMemoryStorage();
    const transport = new TestTransport({
      batchRows: [
        {
          data: { id: "task-3", title: "Batch" },
          modelName: "Task",
        },
      ],
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: [],
      },
      fullRows: [],
    });
    const client = createSyncClient({
      batchMutations: false,
      modelFactory: (modelName: string, data: Record<string, unknown> = {}) =>
        new TaskModel(modelName, data) as TaskInstance,
      reactivity: noopReactivityAdapter,
      schema: modelFactorySchema,
      storage,
      transport,
    });

    try {
      await client.start();
      await storage.put("Task", {
        id: "task-2",
        title: "Stored",
      });

      const created = await client.create<TaskInstance>("Task", {
        id: "task-1",
        title: "Created",
      } as TaskInstance);
      expect(created).toBeInstanceOf(TaskModel);
      expect(created).toBe(client.getCached<TaskInstance>("Task", "task-1"));

      const updated = await client.update<TaskInstance>("Task", "task-1", {
        title: "Updated",
      });
      expect(updated).toBe(created);
      expect(updated.title).toBe("Updated");

      const loaded = await client.get<TaskInstance>("Task", "task-2");
      expect(loaded).toBeInstanceOf(TaskModel);
      expect(loaded).toBe(client.getCached<TaskInstance>("Task", "task-2"));

      const batchLoaded = await client.ensureModel<TaskInstance>(
        "Task",
        "task-3"
      );
      expect(batchLoaded).toBeInstanceOf(TaskModel);
      expect(batchLoaded).toBe(
        client.getCached<TaskInstance>("Task", "task-3")
      );
    } finally {
      await client.stop();
    }
  });

  it("cross-tab: applies deltas from another tab sharing the same storage", async () => {
    // Simulate two browser tabs sharing the same IndexedDB (InMemoryStorage).
    const sharedStorage = new InMemoryStorage();
    const rows: ModelRow[] = [
      {
        data: { id: "task-1", teamId: "team-1", title: "Seed" },
        modelName: "Task",
      },
      {
        data: { id: "team-1", name: "Core" },
        modelName: "Team",
      },
    ];

    // Each tab has its own transport (independent WebSocket connections).
    const transportA = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
    });
    const transportB = new TestTransport({
      fullMetadata: {
        lastSyncId: "10",
        subscribedSyncGroups: ["team-1"],
      },
      fullRows: rows,
    });

    const clientA = createSyncClient({
      batchMutations: false,
      reactivity: noopReactivityAdapter,
      schema,
      storage: sharedStorage,
      transport: transportA,
    });
    const clientB = createSyncClient({
      batchMutations: false,
      reactivity: noopReactivityAdapter,
      schema,
      storage: sharedStorage,
      transport: transportB,
    });

    try {
      await clientA.start();
      await clientB.start();

      // Tab A creates a mutation.
      await clientA.update("Task", "task-1", { title: "Updated by Tab A" });
      const outbox = await sharedStorage.getOutbox();
      const txId = outbox[0]?.clientTxId;
      if (!txId) {
        throw new Error("Expected tx id in outbox");
      }

      // Server confirms and broadcasts the delta to both tabs.
      const delta: DeltaPacket = {
        actions: [
          {
            action: "U",
            clientId: clientA.clientId,
            clientTxId: txId,
            data: { title: "Updated by Tab A" },
            id: "11",
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        lastSyncId: "11",
      };

      const syncA = waitForSync(clientA, "11");
      const syncB = waitForSync(clientB, "11");
      transportA.emitDelta(delta);
      transportB.emitDelta(delta);
      await syncA;
      await syncB;

      // Tab A should have the update (applied optimistically).
      const taskMapA = clientA.getIdentityMap<Record<string, unknown>>("Task");
      expect(taskMapA.get("task-1")).toMatchObject({
        id: "task-1",
        title: "Updated by Tab A",
      });

      // Tab B must also have the update, NOT suppressed as an own echo.
      const taskMapB = clientB.getIdentityMap<Record<string, unknown>>("Task");
      expect(taskMapB.get("task-1")).toMatchObject({
        id: "task-1",
        title: "Updated by Tab A",
      });
    } finally {
      await clientA.stop();
      await clientB.stop();
    }
  });
});
