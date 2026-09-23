/* oxlint-disable max-classes-per-file */
import { noopReactivityAdapter } from "../../core/src/index";
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
  SyncClientEvent,
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
      throw new TypeError(`Missing id for ${modelName}`);
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
      } else if (op.type === "delete" && op.id) {
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
    const idx = this.outbox.findIndex((tx) => tx.clientTxId === clientTxId);
    if (idx !== -1) {
      this.outbox.splice(idx, 1);
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
      ? this.syncActions.filter((a) => a.id > afterSyncId)
      : [...this.syncActions];
    return Promise.resolve(
      typeof limit === "number" ? filtered.slice(0, limit) : filtered
    );
  }
  clearSyncActions(): Promise<void> {
    this.syncActions.length = 0;
    return Promise.resolve();
  }
  pruneSyncActions(beforeSyncId: string): Promise<void> {
    const kept = this.syncActions.filter((a) => a.id > beforeSyncId);
    this.syncActions.length = 0;
    this.syncActions.push(...kept);
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
    for (const r of this.resolvers.splice(0)) {
      r({ done: true, value: undefined as T });
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
  private readonly deltaQueue = new AsyncQueue<DeltaPacket>();
  private readonly fullRows: ModelRow[];
  private readonly fullMetadata: BootstrapMetadata;
  private readonly connectionListeners = new Set<
    (state: ConnectionState) => void
  >();
  private readonly connectionState: ConnectionState = "connected";
  private nextSyncId: number;

  constructor(options: {
    fullRows: ModelRow[];
    fullMetadata: BootstrapMetadata;
    startingSyncId?: number;
  }) {
    this.fullRows = options.fullRows;
    this.fullMetadata = options.fullMetadata;
    this.nextSyncId = options.startingSyncId ?? 100;
  }

  private nextSyncIdString(): string {
    return String(this.nextSyncId);
  }
  bootstrap(
    _options: BootstrapOptions
  ): AsyncGenerator<ModelRow, BootstrapMetadata, unknown> {
    const rows = this.fullRows;
    const metadata = this.fullMetadata;
    return (async function* generate() {
      for (const row of rows) {
        yield row;
      }
      return metadata;
    })();
  }
  batchLoad(
    _options: BatchLoadOptions
  ): AsyncGenerator<ModelRow, void, unknown> {
    // oxlint-disable-next-line consistent-function-scoping
    return (async function* generate() {
      // no batch data
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
    return {
      [Symbol.asyncIterator]: () => this.deltaQueue[Symbol.asyncIterator](),
      unsubscribe: () => this.deltaQueue.close(),
    };
  }
  emitDelta(packet: DeltaPacket): void {
    this.deltaQueue.push(packet);
  }
  fetchDeltas(
    after: string,
    _limit?: number,
    _groups?: string[]
  ): Promise<DeltaPacket> {
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
    this.deltaQueue.close();
    return Promise.resolve();
  }
}

const schema: SchemaDefinition = {
  models: {
    Task: {
      fields: { id: {}, priority: {}, teamId: {}, title: {} },
      groupKey: "teamId",
      loadStrategy: "instant",
    },
    Team: {
      fields: { id: {}, name: {} },
      loadStrategy: "instant",
    },
  },
};

const seedRows: ModelRow[] = [
  {
    data: { id: "task-1", priority: 1, teamId: "team-1", title: "Seed" },
    modelName: "Task",
  },
  { data: { id: "team-1", name: "Core" }, modelName: "Team" },
];

const waitForSync = async (
  client: ReturnType<typeof createSyncClient>,
  expectedSyncId: string
): Promise<void> => {
  // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for sync")),
      2000
    );
    const unsub = client.onEvent((event) => {
      if (
        event.type === "syncComplete" &&
        event.lastSyncId === expectedSyncId
      ) {
        clearTimeout(timeout);
        unsub();
        resolve();
      }
    });
  });
};

const collectEvents = (
  client: ReturnType<typeof createSyncClient>
): { events: SyncClientEvent[]; unsub: () => void } => {
  const events: SyncClientEvent[] = [];
  const unsub = client.onEvent((e) => events.push(e));
  return { events, unsub };
};

// Counterexamples from verification/lean/StrataSync/Rebase.lean:
// bug_echo_after_conflicting_action and bug_echo_suppression_diverges.
const startClientWithPendingTitle = async (): Promise<{
  client: ReturnType<typeof createSyncClient>;
  storage: InMemoryStorage;
  transport: TestTransport;
  tx: Transaction;
}> => {
  const storage = new InMemoryStorage();
  const transport = new TestTransport({
    fullMetadata: { lastSyncId: "10", subscribedSyncGroups: ["team-1"] },
    fullRows: seedRows,
    startingSyncId: 50,
  });
  const client = createSyncClient({
    batchMutations: false,
    reactivity: noopReactivityAdapter,
    schema,
    storage,
    transport,
  });
  await client.start();
  let createdTx: Transaction | undefined;
  await client.update(
    "Task",
    "task-1",
    { title: "Mine" },
    {
      onTransactionCreated: (tx) => {
        createdTx = tx;
      },
    }
  );
  if (!createdTx) {
    throw new Error("update did not create a transaction");
  }
  return { client, storage, transport, tx: createdTx };
};

const foreignThenEcho = (
  client: ReturnType<typeof createSyncClient>,
  tx: Transaction,
  foreignData: Record<string, unknown>
): DeltaPacket => ({
  actions: [
    {
      action: "U",
      clientId: "other-client",
      clientTxId: "other-tx",
      data: { id: "task-1", ...foreignData },
      id: "20",
      modelId: "task-1",
      modelName: "Task",
    },
    {
      action: "U",
      clientId: client.clientId,
      clientTxId: tx.clientTxId,
      data: { id: "task-1", title: "Mine" },
      id: "21",
      modelId: "task-1",
      modelName: "Task",
    },
  ],
  lastSyncId: "21",
});

describe("own echo after a foreign action in the same packet", () => {
  it("confirms the tx instead of reporting a conflict, and converges", async () => {
    const { client, storage, transport, tx } =
      await startClientWithPendingTitle();
    try {
      const { events, unsub } = collectEvents(client);
      const syncWaiter = waitForSync(client, "21");
      // The foreign title write (20) precedes ours (21): ours won.
      transport.emitDelta(foreignThenEcho(client, tx, { title: "Theirs" }));
      await syncWaiter;
      unsub();

      expect(events.filter((e) => e.type === "rebaseConflict")).toEqual([]);
      expect(events.filter((e) => e.type === "mutationRejected")).toEqual([]);
      expect(await storage.getOutbox()).toEqual([]);
      expect(client.canUndo()).toBeTruthy();
      expect(
        await storage.get<Record<string, unknown>>("Task", "task-1")
      ).toMatchObject({ title: "Mine" });
      expect(
        client.getCached<Record<string, unknown>>("Task", "task-1")
      ).toMatchObject({ title: "Mine" });
    } finally {
      await client.stop();
    }
  });

  it("keeps the confirmed local field when a foreign write to another field precedes the echo", async () => {
    const { client, storage, transport, tx } =
      await startClientWithPendingTitle();
    try {
      const syncWaiter = waitForSync(client, "21");
      transport.emitDelta(foreignThenEcho(client, tx, { priority: 9 }));
      await syncWaiter;

      expect(await storage.getOutbox()).toEqual([]);
      expect(
        await storage.get<Record<string, unknown>>("Task", "task-1")
      ).toMatchObject({ priority: 9, title: "Mine" });
      expect(
        client.getCached<Record<string, unknown>>("Task", "task-1")
      ).toMatchObject({ priority: 9, title: "Mine" });
    } finally {
      await client.stop();
    }
  });
});
