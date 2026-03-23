/* oxlint-disable max-classes-per-file */
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
import { OutboxManager } from "../src/outbox-manager";
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
  private readonly modelPersistence = new Map<string, boolean>();
  private readonly outbox: Transaction[] = [];
  private readonly partialIndexes = new Set<string>();
  private readonly syncActions: SyncAction[] = [];
  private meta: StorageMeta = { lastSyncId: "0" };

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

  get<T>(modelName: string, id: string): Promise<T | null> {
    return Promise.resolve(
      (this.data.get(modelName)?.get(id) as T | undefined) ?? null
    );
  }

  getAll<T>(modelName: string): Promise<T[]> {
    const store = this.data.get(modelName);
    return Promise.resolve(store ? ([...store.values()] as T[]) : []);
  }

  put<T extends Record<string, unknown>>(
    modelName: string,
    row: T
  ): Promise<void> {
    const { id } = row;
    if (typeof id !== "string") {
      throw new TypeError(`Missing id for model ${modelName}`);
    }

    const store = this.data.get(modelName) ?? new Map();
    store.set(id, { ...row });
    this.data.set(modelName, store);
    return Promise.resolve();
  }

  delete(modelName: string, id: string): Promise<void> {
    this.data.get(modelName)?.delete(id);
    return Promise.resolve();
  }

  getByIndex<T>(
    modelName: string,
    indexedKey: string,
    key: string
  ): Promise<T[]> {
    const store = this.data.get(modelName);
    if (!store) {
      return Promise.resolve([]);
    }

    const rows: T[] = [];
    for (const row of store.values()) {
      if (row[indexedKey] === key) {
        rows.push(row as T);
      }
    }
    return Promise.resolve(rows);
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
    return Promise.resolve({ ...this.meta });
  }

  setMeta(meta: Partial<StorageMeta>): Promise<void> {
    this.meta = { ...this.meta, ...meta };
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
    return Promise.resolve(
      typeof limit === "number" ? filtered.slice(0, limit) : filtered
    );
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
  resolve: (value: T | PromiseLike<T>) => void;
}

const createDeferred = <T>(): Deferred<T> => {
  let resolve: ((value: T | PromiseLike<T>) => void) | null = null;
  // oxlint-disable-next-line avoid-new, param-names -- wrapping callback API in promise; outer var shadows resolve
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  if (!resolve) {
    throw new Error("Failed to create deferred");
  }

  return { promise, resolve };
};

class TestTransport implements TransportAdapter {
  private readonly mutateImpl: (
    batch: TransactionBatch
  ) => Promise<MutateResult>;

  constructor(mutateImpl: (batch: TransactionBatch) => Promise<MutateResult>) {
    this.mutateImpl = mutateImpl;
  }

  bootstrap(
    _options: BootstrapOptions
  ): AsyncGenerator<ModelRow, BootstrapMetadata, unknown> {
    // oxlint-disable-next-line consistent-function-scoping
    return (async function* generate() {
      await Promise.resolve();
      yield* [];
      return { subscribedSyncGroups: [] };
    })();
  }

  batchLoad(
    _options: BatchLoadOptions
    // oxlint-disable-next-line consistent-function-scoping
  ): AsyncGenerator<ModelRow, void, unknown> {
    // oxlint-disable-next-line consistent-function-scoping
    return (async function* generate() {
      await Promise.resolve();
      yield* [];
    })();
  }

  mutate(batch: TransactionBatch): Promise<MutateResult> {
    return this.mutateImpl(batch);
  }

  subscribe(_options: SubscribeOptions): DeltaSubscription {
    // oxlint-disable-next-line consistent-function-scoping
    return {
      // oxlint-disable-next-line consistent-function-scoping
      [Symbol.asyncIterator]: () =>
        // oxlint-disable-next-line consistent-function-scoping
        (async function* generate() {
          await Promise.resolve();
          yield* [];
        })(),
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
    return Promise.resolve({ actions: [], lastSyncId: after });
  }

  getConnectionState(): ConnectionState {
    return "connected";
  }

  onConnectionStateChange(
    _callback: (state: ConnectionState) => void
  ): () => void {
    return () => {
      /* noop */
    };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe(OutboxManager, () => {
  it("requeues transport failures for reconnect recovery", async () => {
    const storage = new InMemoryStorage();
    const mutate = vi
      .fn<(batch: TransactionBatch) => Promise<MutateResult>>()
      .mockImplementationOnce(() =>
        Promise.reject(new Error("network unavailable"))
      )
      .mockImplementationOnce((batch) =>
        Promise.resolve({
          lastSyncId: "5",
          results: batch.transactions.map((tx) => ({
            clientTxId: tx.clientTxId,
            success: true,
            syncId: "5",
          })),
          success: true,
        })
      );
    const manager = new OutboxManager({
      batchDelay: 1000,
      clientId: "client-1",
      storage,
      transport: new TestTransport(mutate),
    });

    await manager.insert("Task", "task-1", {
      id: "task-1",
      title: "Queued",
    });

    await expect(manager.flush()).rejects.toThrow("network unavailable");

    const queued = await storage.getOutbox();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.state).toBe("queued");
    expect(queued[0]?.retryCount).toBe(1);
    expect(queued[0]?.lastError).toBe("network unavailable");

    await manager.processPendingTransactions();

    expect(mutate).toHaveBeenCalledTimes(2);
    const awaitingSync = await storage.getOutbox();
    expect(awaitingSync[0]?.state).toBe("awaitingSync");
    expect(awaitingSync[0]?.syncIdNeededForCompletion).toBe("5");
    expect(awaitingSync[0]?.lastError).toBeUndefined();

    await manager.completeUpToSyncId("5");
    expect(await storage.getOutbox()).toHaveLength(0);
  });

  it("removes rejected transactions from storage and local echo tracking", async () => {
    const storage = new InMemoryStorage();
    const manager = new OutboxManager({
      batchDelay: 1000,
      batchMutations: false,
      clientId: "client-1",
      storage,
      transport: new TestTransport((batch) => ({
        lastSyncId: "0",
        results: batch.transactions.map((tx) => ({
          clientTxId: tx.clientTxId,
          error: "rejected by server",
          success: false,
        })),
        success: true,
      })),
    });

    const tx = await manager.insert("Task", "task-1", {
      id: "task-1",
      title: "Rejected",
    });

    expect(tx.state).toBe("failed");
    expect(await storage.getOutbox()).toHaveLength(0);
    expect(manager.getLocalClientTxIds().has(tx.clientTxId)).toBeFalsy();
  });

  it("does not double-send a batch that is already in flight", async () => {
    const storage = new InMemoryStorage();
    const mutateDeferred = createDeferred<MutateResult>();
    const mutate = vi.fn(() => mutateDeferred.promise);
    const manager = new OutboxManager({
      batchDelay: 0,
      clientId: "client-1",
      storage,
      transport: new TestTransport(mutate),
    });

    const tx = await manager.insert("Task", "task-1", {
      id: "task-1",
      title: "Pending",
    });

    // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(mutate).toHaveBeenCalledOnce();

    const processPendingPromise = manager.processPendingTransactions();
    await Promise.resolve();
    expect(mutate).toHaveBeenCalledOnce();

    mutateDeferred.resolve({
      lastSyncId: "7",
      results: [
        {
          clientTxId: tx.clientTxId,
          success: true,
          syncId: "7",
        },
      ],
      success: true,
    });

    await processPendingPromise;

    expect(mutate).toHaveBeenCalledOnce();
    const outbox = await storage.getOutbox();
    expect(outbox[0]?.state).toBe("awaitingSync");
    expect(outbox[0]?.syncIdNeededForCompletion).toBe("7");
  });

  it("drops only the invalid transaction from a rejected REST batch", async () => {
    const storage = new InMemoryStorage();
    let invalidClientTxId = "";
    const mutate = vi
      .fn<(batch: TransactionBatch) => Promise<MutateResult>>()
      .mockImplementationOnce(() =>
        Promise.reject(
          Object.assign(new Error("Invalid transaction"), {
            clientTxId: invalidClientTxId,
            code: "INVALID_MUTATION_BATCH",
            details: [{ field: "payload", message: "invalid" }],
          })
        )
      )
      .mockImplementationOnce((batch) =>
        Promise.resolve({
          lastSyncId: "9",
          results: batch.transactions.map((tx) => ({
            clientTxId: tx.clientTxId,
            success: true,
            syncId: "9",
          })),
          success: true,
        })
      );
    const rejected: string[] = [];
    const manager = new OutboxManager({
      batchDelay: 1000,
      clientId: "client-1",
      onTransactionRejected: (tx) => {
        rejected.push(tx.clientTxId);
      },
      storage,
      transport: new TestTransport(mutate),
    });

    const invalidTx = await manager.insert("Task", "task-1", {
      id: "task-1",
      title: "Invalid",
    });
    invalidClientTxId = invalidTx.clientTxId;
    const validTx = await manager.insert("Task", "task-2", {
      id: "task-2",
      title: "Valid",
    });

    await manager.flush();

    expect(rejected).toEqual([invalidTx.clientTxId]);
    expect(mutate).toHaveBeenCalledTimes(2);
    const outbox = await storage.getOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.clientTxId).toBe(validTx.clientTxId);
    expect(outbox[0]?.state).toBe("awaitingSync");
    expect(outbox[0]?.syncIdNeededForCompletion).toBe("9");
  });
});
