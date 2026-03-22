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
    // biome-ignore lint/suspicious/useAwait: async generator required for return type
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

describe("rebase integration", () => {
  it("update-update conflict with overlapping fields resolves server-wins", async () => {
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

    try {
      await client.start();

      // Create a pending update for title
      await client.update("Task", "task-1", { title: "Client Title" });
      const outboxBefore = await storage.getOutbox();
      expect(outboxBefore.length).toBeGreaterThanOrEqual(1);

      const { events, unsub } = collectEvents(client);

      // Server sends update for the same field (title) from another client
      const delta: DeltaPacket = {
        actions: [
          {
            action: "U",
            data: { id: "task-1", priority: 1, title: "Server Title" },
            id: "20",
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        lastSyncId: "20",
      };

      const syncWaiter = waitForSync(client, "20");
      transport.emitDelta(delta);
      await syncWaiter;

      // Conflict should have been detected and the local tx removed
      const outboxAfter = await storage.getOutbox();
      const remainingUpdateTxs = outboxAfter.filter(
        (tx) => tx.action === "U" && tx.modelName === "Task"
      );
      expect(remainingUpdateTxs).toHaveLength(0);

      // A rebaseConflict event should have been emitted
      const conflictEvents = events.filter((e) => e.type === "rebaseConflict");
      expect(conflictEvents).toHaveLength(1);
      expect(conflictEvents[0]).toMatchObject({
        conflictType: "update-update",
        modelId: "task-1",
        modelName: "Task",
        resolution: "server-wins",
        type: "rebaseConflict",
      });

      unsub();
    } finally {
      await client.stop();
    }
  });

  it("update-update with non-overlapping fields does not conflict (field-level merge)", async () => {
    const storage = new InMemoryStorage();
    const transport = new TestTransport({
      fullMetadata: { lastSyncId: "10", subscribedSyncGroups: ["team-1"] },
      fullRows: seedRows,
      startingSyncId: 50,
    });

    const client = createSyncClient({
      batchMutations: false,
      fieldLevelConflicts: true,
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    });

    try {
      await client.start();

      // Local update changes title
      await client.update("Task", "task-1", { title: "My Title" });

      const { events, unsub } = collectEvents(client);

      // Server update changes priority (different field)
      const delta: DeltaPacket = {
        actions: [
          {
            action: "U",
            data: { id: "task-1", priority: 5 },
            id: "20",
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        lastSyncId: "20",
      };

      const syncWaiter = waitForSync(client, "20");
      transport.emitDelta(delta);
      await syncWaiter;

      // No conflict should be emitted
      const conflictEvents = events.filter((e) => e.type === "rebaseConflict");
      expect(conflictEvents).toHaveLength(0);

      // Pending update should still be in the outbox
      const outbox = await storage.getOutbox();
      const titleUpdates = outbox.filter(
        (tx) => tx.action === "U" && tx.modelName === "Task"
      );
      expect(titleUpdates).toHaveLength(1);

      // The pending tx should remain with its title payload intact
      expect(titleUpdates[0]?.payload).toMatchObject({ title: "My Title" });

      unsub();
    } finally {
      await client.stop();
    }
  });

  it("update-delete conflict resolves server-wins (delete wins)", async () => {
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

    try {
      await client.start();

      // Local update
      await client.update("Task", "task-1", { title: "Updated" });

      const { events, unsub } = collectEvents(client);

      // Server deletes the same entity
      const delta: DeltaPacket = {
        actions: [
          {
            action: "D",
            data: {},
            id: "20",
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        lastSyncId: "20",
      };

      const syncWaiter = waitForSync(client, "20");
      transport.emitDelta(delta);
      await syncWaiter;

      // The update tx should be removed from outbox
      const outbox = await storage.getOutbox();
      const taskTxs = outbox.filter((tx) => tx.modelName === "Task");
      expect(taskTxs).toHaveLength(0);

      // Conflict event emitted
      const conflictEvents = events.filter((e) => e.type === "rebaseConflict");
      expect(conflictEvents).toHaveLength(1);
      expect(conflictEvents[0]).toMatchObject({
        conflictType: "update-delete",
        resolution: "server-wins",
      });

      unsub();
    } finally {
      await client.stop();
    }
  });

  it("delete-update conflict resolves server-wins (update wins)", async () => {
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

    try {
      await client.start();

      // Local delete
      await client.delete("Task", "task-1", {
        original: {
          id: "task-1",
          priority: 1,
          teamId: "team-1",
          title: "Seed",
        },
      });

      const { events, unsub } = collectEvents(client);

      // Server updates the same entity
      const delta: DeltaPacket = {
        actions: [
          {
            action: "U",
            data: {
              id: "task-1",
              priority: 1,
              teamId: "team-1",
              title: "Server Update",
            },
            id: "20",
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        lastSyncId: "20",
      };

      const syncWaiter = waitForSync(client, "20");
      transport.emitDelta(delta);
      await syncWaiter;

      // The delete tx should be removed (server-wins)
      const outbox = await storage.getOutbox();
      const deleteTxs = outbox.filter(
        (tx) => tx.action === "D" && tx.modelName === "Task"
      );
      expect(deleteTxs).toHaveLength(0);

      const conflictEvents = events.filter((e) => e.type === "rebaseConflict");
      expect(conflictEvents).toHaveLength(1);
      expect(conflictEvents[0]).toMatchObject({
        conflictType: "delete-update",
        resolution: "server-wins",
      });

      unsub();
    } finally {
      await client.stop();
    }
  });

  it("insert-insert conflict resolves server-wins", async () => {
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

    try {
      await client.start();

      // Local insert with specific ID
      await client.create("Task", {
        id: "task-dup",
        teamId: "team-1",
        title: "Client Version",
      });

      const { events, unsub } = collectEvents(client);

      // Server inserts same ID
      const delta: DeltaPacket = {
        actions: [
          {
            action: "I",
            data: {
              id: "task-dup",
              teamId: "team-1",
              title: "Server Version",
            },
            id: "20",
            modelId: "task-dup",
            modelName: "Task",
          },
        ],
        lastSyncId: "20",
      };

      const syncWaiter = waitForSync(client, "20");
      transport.emitDelta(delta);
      await syncWaiter;

      // Insert tx should be removed
      const outbox = await storage.getOutbox();
      const insertTxs = outbox.filter(
        (tx) => tx.action === "I" && tx.modelId === "task-dup"
      );
      expect(insertTxs).toHaveLength(0);

      const conflictEvents = events.filter((e) => e.type === "rebaseConflict");
      expect(conflictEvents).toHaveLength(1);
      expect(conflictEvents[0]).toMatchObject({
        conflictType: "insert-insert",
      });

      unsub();
    } finally {
      await client.stop();
    }
  });

  it("no conflict when delta targets different entities", async () => {
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

    try {
      await client.start();

      // Local update on task-1
      await client.update("Task", "task-1", { title: "Local" });
      const outboxBefore = await storage.getOutbox();
      const pendingCount = outboxBefore.filter(
        (tx) => tx.action === "U" && tx.modelName === "Task"
      ).length;

      const { events, unsub } = collectEvents(client);

      // Server updates a totally different entity
      const delta: DeltaPacket = {
        actions: [
          {
            action: "U",
            data: { id: "team-1", name: "Renamed" },
            id: "20",
            modelId: "team-1",
            modelName: "Team",
          },
        ],
        lastSyncId: "20",
      };

      const syncWaiter = waitForSync(client, "20");
      transport.emitDelta(delta);
      await syncWaiter;

      // No conflict
      const conflictEvents = events.filter((e) => e.type === "rebaseConflict");
      expect(conflictEvents).toHaveLength(0);

      // Pending update still in outbox
      const outboxAfter = await storage.getOutbox();
      const remaining = outboxAfter.filter(
        (tx) => tx.action === "U" && tx.modelName === "Task"
      );
      expect(remaining).toHaveLength(pendingCount);

      unsub();
    } finally {
      await client.stop();
    }
  });

  it("archive-delete conflict is detected via normalization", async () => {
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

    try {
      await client.start();

      // Local archive
      await client.archive("Task", "task-1", {
        original: {
          id: "task-1",
          priority: 1,
          teamId: "team-1",
          title: "Seed",
        },
      });

      const { events, unsub } = collectEvents(client);

      // Server deletes the same entity
      const delta: DeltaPacket = {
        actions: [
          {
            action: "D",
            data: {},
            id: "20",
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        lastSyncId: "20",
      };

      const syncWaiter = waitForSync(client, "20");
      transport.emitDelta(delta);
      await syncWaiter;

      // Archive tx removed (server-wins)
      const outbox = await storage.getOutbox();
      const archiveTxs = outbox.filter(
        (tx) => tx.action === "A" && tx.modelName === "Task"
      );
      expect(archiveTxs).toHaveLength(0);

      // Conflict detected as update-delete (archive normalized to update)
      const conflictEvents = events.filter((e) => e.type === "rebaseConflict");
      expect(conflictEvents).toHaveLength(1);
      expect(conflictEvents[0]).toMatchObject({
        conflictType: "update-delete",
        resolution: "server-wins",
      });

      unsub();
    } finally {
      await client.stop();
    }
  });

  it("confirmed own transaction is not treated as conflict", async () => {
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

    try {
      await client.start();

      let createdTx: Transaction | undefined;
      await client.update(
        "Task",
        "task-1",
        { title: "My Update" },
        {
          onTransactionCreated: (tx) => {
            createdTx = tx;
          },
        }
      );

      expect(createdTx).toBeDefined();

      const { events, unsub } = collectEvents(client);

      // Server echoes back our own transaction
      const delta: DeltaPacket = {
        actions: [
          {
            action: "U",
            clientId: client.clientId,
            clientTxId: createdTx?.clientTxId,
            data: { id: "task-1", title: "My Update" },
            id: "20",
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        lastSyncId: "20",
      };

      const syncWaiter = waitForSync(client, "20");
      transport.emitDelta(delta);
      await syncWaiter;

      // No conflict events — this is a confirmation, not a conflict
      const conflictEvents = events.filter((e) => e.type === "rebaseConflict");
      expect(conflictEvents).toHaveLength(0);

      unsub();
    } finally {
      await client.stop();
    }
  });
});
