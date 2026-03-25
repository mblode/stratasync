/* eslint-disable max-classes-per-file */
/* oxlint-disable max-classes-per-file */
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

class MemoryStorage implements StorageAdapter {
  private readonly data = new Map<
    string,
    Map<string, Record<string, unknown>>
  >();
  private readonly outbox: Transaction[] = [];
  private readonly partialIndexes = new Set<string>();
  private meta: StorageMeta;

  constructor(schemaHash: string, rows: ModelRow[] = []) {
    this.meta = {
      bootstrapComplete: true,
      lastSyncId: "7",
      schemaHash,
    };

    for (const row of rows) {
      const { id } = row.data;
      if (typeof id !== "string") {
        continue;
      }
      const store = this.getModelStore(row.modelName);
      store.set(id, { ...row.data });
    }
  }

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
    return Promise.resolve((store?.get(id) as T | undefined) ?? null);
  }

  getAll<T>(modelName: string): Promise<T[]> {
    const store = this.data.get(modelName);
    return Promise.resolve((store ? [...store.values()] : []) as T[]);
  }

  put<T extends Record<string, unknown>>(
    modelName: string,
    row: T
  ): Promise<void> {
    const { id } = row;
    if (typeof id !== "string") {
      throw new TypeError(`Missing id for model ${modelName}`);
    }
    this.getModelStore(modelName).set(id, { ...row });
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

    const matches = [...store.values()].filter((row) => row[indexName] === key);
    return Promise.resolve(matches as T[]);
  }

  writeBatch(
    ops: {
      type: "put" | "delete";
      modelName: string;
      id?: string;
      data?: Record<string, unknown>;
    }[]
  ): Promise<void> {
    for (const op of ops) {
      if (op.type === "delete" && op.id) {
        this.data.get(op.modelName)?.delete(op.id);
        continue;
      }

      if (op.type === "put" && op.data) {
        const { id } = op.data;
        if (typeof id !== "string") {
          throw new TypeError(`Missing id for model ${op.modelName}`);
        }
        this.getModelStore(op.modelName).set(id, { ...op.data });
      }
    }

    return Promise.resolve();
  }

  getMeta(): Promise<StorageMeta> {
    return Promise.resolve({ ...this.meta });
  }

  setMeta(meta: Partial<StorageMeta>): Promise<void> {
    this.meta = {
      ...this.meta,
      ...meta,
    };
    return Promise.resolve();
  }

  getModelPersistence(modelName: string): Promise<ModelPersistenceMeta> {
    return Promise.resolve({
      modelName,
      persisted: true,
    });
  }

  setModelPersistence(_modelName: string, _persisted: boolean): Promise<void> {
    return Promise.resolve();
  }

  getOutbox(): Promise<Transaction[]> {
    return Promise.resolve([...this.outbox]);
  }

  addToOutbox(tx: Transaction): Promise<void> {
    this.outbox.push({ ...tx });
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

  addSyncActions(_actions: SyncAction[]): Promise<void> {
    return Promise.resolve();
  }

  getSyncActions(
    _afterSyncId?: string,
    _limit?: number
  ): Promise<SyncAction[]> {
    return Promise.resolve([]);
  }

  clearSyncActions(): Promise<void> {
    return Promise.resolve();
  }

  clear(_options?: ClearStorageOptions): Promise<void> {
    this.data.clear();
    this.outbox.length = 0;
    this.partialIndexes.clear();
    return Promise.resolve();
  }

  count(modelName: string): Promise<number> {
    return Promise.resolve(this.data.get(modelName)?.size ?? 0);
  }
}

class FailingOutboxStorage extends MemoryStorage {
  override addToOutbox(_tx: Transaction): Promise<void> {
    return Promise.reject(new Error("idb write failed"));
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

class RejectingTransport extends NoopTransport {
  override mutate(batch: TransactionBatch): Promise<MutateResult> {
    return Promise.resolve({
      lastSyncId: "7",
      results: batch.transactions.map((tx) => ({
        clientTxId: tx.clientTxId,
        error: "rejected by server",
        success: false,
      })),
      success: true,
    });
  }
}

class BatchLoadTransport extends NoopTransport {
  private readonly batchRows: ModelRow[];

  constructor(batchRows: ModelRow[]) {
    super();
    this.batchRows = batchRows;
  }

  override async *batchLoad(
    options: BatchLoadOptions
  ): AsyncGenerator<ModelRow, void, unknown> {
    for (const request of options.requests) {
      for (const row of this.batchRows) {
        if (row.modelName !== request.modelName) {
          continue;
        }
        if (row.data[request.indexedKey] !== request.keyValue) {
          continue;
        }
        yield row;
      }
    }
  }
}

const partialTaskSchema: SchemaDefinition = {
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

class TaskRecord {
  id = "";
  title = "";

  constructor(data: Record<string, unknown> = {}) {
    Object.assign(this, data);
  }

  label(): string {
    return `${this.id}:${this.title}`;
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
  it("rejects mutations before start without mutating local state", async () => {
    const client = createSyncClient({
      reactivity: noopReactivityAdapter,
      schema,
      storage: new DelayedOpenStorage(
        new ModelRegistry(schema).getSchemaHash(),
        []
      ),
      transport: new NoopTransport(),
    });

    await expect(
      client.create("Task", {
        id: "task-1",
        title: "Draft",
      })
    ).rejects.toThrow("Sync client must be started before mutations");

    expect(client.getCached("Task", "task-1")).toBeNull();
    expect(client.canUndo()).toBeFalsy();
    expect(client.canRedo()).toBeFalsy();
  });

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

  it("waits for startup before queueing mutations with the real client id", async () => {
    const storage = new MemoryStorage(
      new ModelRegistry(schema).getSchemaHash()
    );
    const bootstrapReady = createDeferred<undefined>();

    class DeferredBootstrapTransport extends NoopTransport {
      lastClientId: string | undefined;

      override bootstrap(
        _options: BootstrapOptions
      ): AsyncGenerator<ModelRow, BootstrapMetadata, unknown> {
        // oxlint-disable-next-line require-yield -- returns metadata after an async gate without streaming rows
        return (async function* generate() {
          await bootstrapReady.promise;
          yield* [];
          return {
            lastSyncId: "7",
            subscribedSyncGroups: [],
          };
        })();
      }

      override mutate(batch: TransactionBatch): Promise<MutateResult> {
        this.lastClientId = batch.transactions[0]?.clientId;
        return super.mutate(batch);
      }
    }

    const transport = new DeferredBootstrapTransport();
    const client = createSyncClient({
      batchMutations: false,
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    const startPromise = client.start();
    const createPromise = client.create("Task", {
      id: "task-1",
      title: "Queued",
    });
    let settled = false;

    // oxlint-disable-next-line prefer-await-to-then -- test probe
    createPromise.finally(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBeFalsy();
    expect(client.getCached("Task", "task-1")).toBeNull();

    bootstrapReady.resolve();

    await expect(startPromise).resolves.toBeUndefined();
    await expect(createPromise).resolves.toMatchObject({
      id: "task-1",
      title: "Queued",
    });

    expect(transport.lastClientId).toBe(client.clientId);
    expect(transport.lastClientId).not.toBe("temp");

    await client.stop();
  });

  it("does not queue or apply mutations once stop wins the lifecycle race", async () => {
    const storage = new MemoryStorage(
      new ModelRegistry(schema).getSchemaHash(),
      [
        {
          data: { id: "task-1", title: "Seed" },
          modelName: "Task",
        },
      ]
    );
    const client = createSyncClient({
      batchMutations: false,
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport: new NoopTransport(),
    });

    await client.start();

    const updatePromise = client.update("Task", "task-1", {
      title: "Stopped",
    });
    await client.stop();

    await expect(updatePromise).rejects.toThrow(
      "Sync client must be started before mutations"
    );
    expect(client.getCached("Task", "task-1")).toMatchObject({
      id: "task-1",
      title: "Seed",
    });
    expect(await storage.getOutbox()).toHaveLength(0);
  });

  it("does not retain undo history for immediately rejected mutations", async () => {
    const storage = new DelayedOpenStorage(
      new ModelRegistry(schema).getSchemaHash(),
      []
    );
    storage.releaseOpen();

    const client = createSyncClient({
      batchMutations: false,
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport: new RejectingTransport(),
    });

    await client.start();

    expect(client.canUndo()).toBeFalsy();

    await client.create("Task", {
      id: "task-1",
      title: "Rejected",
    });

    expect(client.getCached("Task", "task-1")).toBeNull();
    expect(await storage.getOutbox()).toHaveLength(0);
    expect(client.canUndo()).toBeFalsy();
    expect(client.canRedo()).toBeFalsy();

    await client.stop();
  });

  it("rolls back optimistic updates when the outbox write fails", async () => {
    const storage = new FailingOutboxStorage(
      new ModelRegistry(schema).getSchemaHash(),
      [
        {
          data: { id: "task-1", title: "Seed" },
          modelName: "Task",
        },
      ]
    );
    const client = createSyncClient({
      batchMutations: false,
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport: new NoopTransport(),
    });

    await client.start();

    await expect(
      client.update("Task", "task-1", {
        title: "Changed",
      })
    ).rejects.toThrow("idb write failed");

    expect(client.getCached<Record<string, unknown>>("Task", "task-1")).toEqual(
      {
        id: "task-1",
        title: "Seed",
      }
    );
    expect(await storage.getOutbox()).toHaveLength(0);
    expect(client.canUndo()).toBeFalsy();

    await client.stop();
  });
});

describe("createSyncClient model factories", () => {
  it("uses direct factories with default params and returns canonical instances", async () => {
    const schemaHash = new ModelRegistry(partialTaskSchema).getSchemaHash();
    const storage = new MemoryStorage(schemaHash, [
      {
        data: { id: "task-stored", title: "Stored" },
        modelName: "Task",
      },
    ]);
    const transport = new BatchLoadTransport([
      {
        data: { id: "task-batch", title: "Batch" },
        modelName: "Task",
      },
    ]);
    const client = createSyncClient({
      batchMutations: false,
      modelFactory: (_modelName: string, data: Record<string, unknown> = {}) =>
        new TaskRecord(data),
      reactivity: noopReactivityAdapter,
      schema: partialTaskSchema,
      storage,
      transport,
    });

    try {
      await client.start();

      const created = await client.create("Task", {
        id: "task-created",
        title: "Created",
      });
      expect(created).toBeInstanceOf(TaskRecord);
      expect(created).toBe(client.getCached("Task", "task-created"));
      expect((created as TaskRecord).label()).toBe("task-created:Created");

      const stored = await client.get("Task", "task-stored");
      expect(stored).toBeInstanceOf(TaskRecord);
      expect(stored).toBe(client.getCached("Task", "task-stored"));

      const batchLoaded = await client.ensureModel("Task", "task-batch");
      expect(batchLoaded).toBeInstanceOf(TaskRecord);
      expect(batchLoaded).toBe(client.getCached("Task", "task-batch"));

      const updated = await client.update("Task", "task-created", {
        title: "Updated",
      });
      expect(updated).toBe(created);
      expect(updated).toBe(client.getCached("Task", "task-created"));
      expect((updated as TaskRecord).label()).toBe("task-created:Updated");
    } finally {
      await client.stop();
    }
  });
});
