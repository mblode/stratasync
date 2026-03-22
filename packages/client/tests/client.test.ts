import { ModelRegistry, noopReactivityAdapter } from "../../core/src/index";
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
import { createSyncClient } from "../src/index";
import type {
  ClearStorageOptions,
  ModelPersistenceMeta,
  StorageAdapter,
  StorageMeta,
  TransportAdapter,
} from "../src/types";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

const createDeferred = <T>(): Deferred<T> => {
  // oxlint-disable-next-line consistent-function-scoping -- noop placeholder reassigned inside Promise constructor
  let resolve: (value: T | PromiseLike<T>) => void = () => {
    /* noop */
  };

  // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
  const promise = new Promise<T>((_resolve) => {
    resolve = _resolve;
  });

  return { promise, resolve };
};

const schema: SchemaDefinition = {
  models: {
    Task: {
      fields: {
        id: {},
        title: {},
      },
      loadStrategy: "instant",
    },
  },
};

class DelayedOpenStorage implements StorageAdapter {
  // oxlint-disable-next-line no-invalid-void-type -- void is the correct type for a signal-only deferred
  private readonly openDeferred = createDeferred<void>();
  private readonly outbox: Transaction[];
  private meta: StorageMeta;
  private isOpen = false;

  openCalls = 0;
  getOutboxWhileClosedCalls = 0;

  constructor(schemaHash: string, outbox: Transaction[]) {
    this.outbox = [...outbox];
    this.meta = {
      bootstrapComplete: true,
      lastSyncId: "7",
      schemaHash,
    };
  }

  releaseOpen(): void {
    this.isOpen = true;
    this.openDeferred.resolve();
  }

  async open(_options: {
    name?: string;
    userId?: string;
    version?: number;
    userVersion?: number;
    schema?: SchemaDefinition | ModelRegistrySnapshot;
  }): Promise<void> {
    this.openCalls += 1;
    await this.openDeferred.promise;
  }

  close(): Promise<void> {
    this.isOpen = false;
    return Promise.resolve();
  }

  private ensureOpen(): void {
    if (!this.isOpen) {
      this.getOutboxWhileClosedCalls += 1;
      throw new Error("Database not open. Call open() first.");
    }
  }

  get<T>(_modelName: string, _id: string): Promise<T | null> {
    this.ensureOpen();
    return Promise.resolve(null);
  }

  getAll<T>(_modelName: string): Promise<T[]> {
    this.ensureOpen();
    return Promise.resolve([]);
  }

  put<T extends Record<string, unknown>>(
    _modelName: string,
    _row: T
  ): Promise<void> {
    this.ensureOpen();
    return Promise.resolve();
  }

  delete(_modelName: string, _id: string): Promise<void> {
    this.ensureOpen();
    return Promise.resolve();
  }

  getByIndex<T>(
    _modelName: string,
    _indexName: string,
    _key: string
  ): Promise<T[]> {
    this.ensureOpen();
    return Promise.resolve([]);
  }

  writeBatch(
    _ops: {
      type: "put" | "delete";
      modelName: string;
      id?: string;
      data?: Record<string, unknown>;
    }[]
  ): Promise<void> {
    this.ensureOpen();
    return Promise.resolve();
  }

  getMeta(): Promise<StorageMeta> {
    this.ensureOpen();
    return Promise.resolve({ ...this.meta });
  }

  setMeta(meta: Partial<StorageMeta>): Promise<void> {
    this.ensureOpen();
    this.meta = {
      ...this.meta,
      ...meta,
    };
    return Promise.resolve();
  }

  getModelPersistence(modelName: string): Promise<ModelPersistenceMeta> {
    this.ensureOpen();
    return Promise.resolve({
      modelName,
      persisted: true,
    });
  }

  setModelPersistence(_modelName: string, _persisted: boolean): Promise<void> {
    this.ensureOpen();
    return Promise.resolve();
  }

  getOutbox(): Promise<Transaction[]> {
    this.ensureOpen();
    return Promise.resolve([...this.outbox]);
  }

  addToOutbox(tx: Transaction): Promise<void> {
    this.ensureOpen();
    this.outbox.push(tx);
    return Promise.resolve();
  }

  removeFromOutbox(clientTxId: string): Promise<void> {
    this.ensureOpen();
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
    this.ensureOpen();
    const tx = this.outbox.find((entry) => entry.clientTxId === clientTxId);
    if (tx) {
      Object.assign(tx, updates);
    }
    return Promise.resolve();
  }

  hasPartialIndex(
    _modelName: string,
    _indexedKey: string,
    _keyValue: string
  ): Promise<boolean> {
    this.ensureOpen();
    return Promise.resolve(false);
  }

  setPartialIndex(
    _modelName: string,
    _indexedKey: string,
    _keyValue: string
  ): Promise<void> {
    this.ensureOpen();
    return Promise.resolve();
  }

  addSyncActions(_actions: SyncAction[]): Promise<void> {
    this.ensureOpen();
    return Promise.resolve();
  }

  getSyncActions(
    _afterSyncId?: string,
    _limit?: number
  ): Promise<SyncAction[]> {
    this.ensureOpen();
    return Promise.resolve([]);
  }

  clearSyncActions(): Promise<void> {
    this.ensureOpen();
    return Promise.resolve();
  }

  clear(_options?: ClearStorageOptions): Promise<void> {
    this.ensureOpen();
    return Promise.resolve();
  }

  count(_modelName: string): Promise<number> {
    this.ensureOpen();
    return Promise.resolve(0);
  }
}

// oxlint-disable-next-line max-classes-per-file -- test helpers colocated
class NoopTransport implements TransportAdapter {
  private readonly connectionListeners = new Set<
    (state: ConnectionState) => void
  >();

  // oxlint-disable-next-line require-yield -- returns metadata without yielding rows for noop
  async *bootstrap(
    _options: BootstrapOptions
  ): AsyncGenerator<ModelRow, BootstrapMetadata, unknown> {
    return {
      lastSyncId: "7",
      subscribedSyncGroups: [],
    };
  }

  // oxlint-disable-next-line require-yield -- empty async generator for noop
  async *batchLoad(
    _options: BatchLoadOptions
  ): AsyncGenerator<ModelRow, void, unknown> {
    /* noop */
  }

  mutate(batch: TransactionBatch): Promise<MutateResult> {
    return Promise.resolve({
      lastSyncId: "7",
      results: batch.transactions.map((tx) => ({
        clientTxId: tx.clientTxId,
        success: true,
        syncId: "7",
      })),
      success: true,
    });
  }

  subscribe(_options: SubscribeOptions): DeltaSubscription {
    return {
      // oxlint-disable-next-line require-yield -- empty async generator for noop
      async *[Symbol.asyncIterator]() {
        /* noop */
      },
      unsubscribe: () => {
        /* noop */
      },
    };
  }

  fetchDeltas(
    after: string,
    _limit?: number,
    _groups?: string[]
  ): Promise<DeltaPacket> {
    return Promise.resolve({
      actions: [],
      lastSyncId: after,
    });
  }

  getConnectionState(): ConnectionState {
    return "connected";
  }

  onConnectionStateChange(
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback: (state: ConnectionState) => void
  ): () => void {
    this.connectionListeners.add(callback);
    // oxlint-disable-next-line prefer-await-to-callbacks -- synchronous invocation for immediate state
    callback("connected");
    return () => {
      this.connectionListeners.delete(callback);
    };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const createQueuedTransaction = (clientTxId: string): Transaction => ({
  action: "I",
  clientId: "client-1",
  clientTxId,
  createdAt: Date.now(),
  modelId: clientTxId,
  modelName: "Task",
  payload: {
    id: clientTxId,
    title: clientTxId,
  },
  retryCount: 0,
  state: "queued",
});

describe("createSyncClient lifecycle", () => {
  it("waits for an in-flight start before reading pending count", async () => {
    const storage = new DelayedOpenStorage(
      new ModelRegistry(schema).getSchemaHash(),
      [createQueuedTransaction("task-1"), createQueuedTransaction("task-2")]
    );
    const client = createSyncClient({
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport: new NoopTransport(),
    });

    const startPromise = client.start();
    const pendingCountPromise = client.getPendingCount();
    let settled = false;

    // oxlint-disable-next-line prefer-await-to-then -- test probe
    pendingCountPromise.finally(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBeFalsy();

    storage.releaseOpen();

    await expect(pendingCountPromise).resolves.toBe(2);
    await expect(startPromise).resolves.toBeUndefined();
    expect(storage.getOutboxWhileClosedCalls).toBe(0);

    await client.stop();
  });

  it("reuses the same start promise while startup is in flight", async () => {
    const storage = new DelayedOpenStorage(
      new ModelRegistry(schema).getSchemaHash(),
      [createQueuedTransaction("task-1")]
    );
    const client = createSyncClient({
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport: new NoopTransport(),
    });

    const firstStart = client.start();
    const secondStart = client.start();

    expect(secondStart).toBe(firstStart);

    storage.releaseOpen();

    await expect(firstStart).resolves.toBeUndefined();
    expect(storage.openCalls).toBe(1);

    await client.stop();
  });
});
