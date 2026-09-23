/* oxlint-disable max-classes-per-file */
// Harness copied from own-echo-convergence.test.ts; fetchDeltas replays the
// emitted log so a packet that was not durably applied can be redelivered.
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
  /** When set, the next `getMeta()` rejects once (a transient storage fault). */
  failNextGetMeta = false;
  getMetaFailures = 0;
  getMeta(): Promise<StorageMeta> {
    if (this.failNextGetMeta) {
      this.failNextGetMeta = false;
      this.getMetaFailures += 1;
      return Promise.reject(new Error("transient storage fault"));
    }
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
  /** Every action the server has emitted: `fetchDeltas` replays from it. */
  private readonly log: SyncAction[] = [];
  emitDelta(packet: DeltaPacket): void {
    this.log.push(...packet.actions);
    this.deltaQueue.push(packet);
  }
  fetchDeltas(
    after: string,
    _limit?: number,
    _groups?: string[]
  ): Promise<DeltaPacket> {
    const actions = this.log.filter(
      (action) => Number(action.id) > Number(after)
    );
    const lastSyncId = actions.at(-1)?.id ?? after;
    return Promise.resolve({ actions, lastSyncId });
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

const startClient = async (): Promise<{
  client: ReturnType<typeof createSyncClient>;
  storage: InMemoryStorage;
  transport: TestTransport;
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
  return { client, storage, transport };
};

const foreignUpdate = (
  id: string,
  modelId: string,
  data: Record<string, unknown>
): SyncAction => ({
  action: "U",
  clientId: "other-client",
  clientTxId: `other-tx-${id}`,
  data: { id: modelId, ...data },
  id,
  modelId,
  modelName: "Task",
});

// Counterexample from verification/lean/StrataSync/DeltaPipeline.lean:
// bug_maps_lag_after_post_advance_throw.
describe("a packet that fails after its rows are written", () => {
  it("is redelivered, so the identity maps never permanently lag the cursor", async () => {
    const { client, storage, transport } = await startClient();
    try {
      const { events, unsub } = collectEvents(client);
      // A transient storage fault between the row write and the identity-map
      // batch (getMeta reads the privacy-withheld ids for the replay).
      storage.failNextGetMeta = true;
      transport.emitDelta({
        actions: [foreignUpdate("20", "task-1", { title: "Theirs" })],
        lastSyncId: "20",
      });
      await vi.waitFor(() => {
        expect(storage.getMetaFailures).toBe(1);
        expect(events.some((e) => e.type === "syncError")).toBeTruthy();
      });
      unsub();

      // The row write landed; the maps must either show it or the cursor
      // must still sit below it so the packet is fetched again.
      expect(
        await storage.get<Record<string, unknown>>("Task", "task-1")
      ).toMatchObject({ title: "Theirs" });

      await client.syncNow();

      expect(
        client.getCached<Record<string, unknown>>("Task", "task-1")
      ).toMatchObject({ title: "Theirs" });
      // oxlint-disable-next-line no-await-expression-member
      expect((await storage.getMeta()).lastSyncId).toBe("20");
    } finally {
      await client.stop();
    }
  });
});

// Partial-load semantics (apps/docs/guides/load-strategies.mdx): deltas "apply
// only for loaded instances". An update carries only the changed fields, so
// staging it for a row that is not stored locally must not invent a stub row.
describe("an update for a row that is not stored locally", () => {
  it("does not create a stub row from the changed fields", async () => {
    const { client, storage, transport } = await startClient();
    try {
      const syncWaiter = waitForSync(client, "20");
      transport.emitDelta({
        actions: [foreignUpdate("20", "task-unloaded", { title: "Partial" })],
        lastSyncId: "20",
      });
      await syncWaiter;

      expect(await storage.get("Task", "task-unloaded")).toBeNull();
      expect(client.getCached("Task", "task-unloaded")).toBeFalsy();
    } finally {
      await client.stop();
    }
  });

  it("does not create a stub row for an archive or unarchive", async () => {
    const { client, storage, transport } = await startClient();
    try {
      const syncWaiter = waitForSync(client, "21");
      transport.emitDelta({
        actions: [
          {
            action: "A",
            clientId: "other-client",
            data: { archivedAt: 1_736_899_200_000 },
            id: "20",
            modelId: "task-unloaded",
            modelName: "Task",
          },
          {
            action: "V",
            clientId: "other-client",
            data: { archivedAt: null },
            id: "21",
            modelId: "task-unloaded-2",
            modelName: "Task",
          },
        ],
        lastSyncId: "21",
      });
      await syncWaiter;

      expect(await storage.get("Task", "task-unloaded")).toBeNull();
      expect(await storage.get("Task", "task-unloaded-2")).toBeNull();
      expect(client.getCached("Task", "task-unloaded")).toBeFalsy();
      expect(client.getCached("Task", "task-unloaded-2")).toBeFalsy();
    } finally {
      await client.stop();
    }
  });

  it("does not resurrect a row deleted earlier in the same packet", async () => {
    const { client, storage, transport } = await startClient();
    try {
      const syncWaiter = waitForSync(client, "21");
      transport.emitDelta({
        actions: [
          {
            action: "D",
            clientId: "other-client",
            data: {},
            id: "20",
            modelId: "task-1",
            modelName: "Task",
          },
          foreignUpdate("21", "task-1", { title: "Late" }),
        ],
        lastSyncId: "21",
      });
      await syncWaiter;

      expect(await storage.get("Task", "task-1")).toBeNull();
      expect(client.getCached("Task", "task-1")).toBeFalsy();
    } finally {
      await client.stop();
    }
  });

  it("still merges an update into a row inserted earlier in the same packet", async () => {
    const { client, storage, transport } = await startClient();
    try {
      const syncWaiter = waitForSync(client, "21");
      transport.emitDelta({
        actions: [
          {
            action: "I",
            clientId: "other-client",
            data: { id: "task-2", priority: 2, teamId: "team-1", title: "New" },
            id: "20",
            modelId: "task-2",
            modelName: "Task",
          },
          foreignUpdate("21", "task-2", { title: "Renamed" }),
        ],
        lastSyncId: "21",
      });
      await syncWaiter;

      expect(
        await storage.get<Record<string, unknown>>("Task", "task-2")
      ).toEqual({
        id: "task-2",
        priority: 2,
        teamId: "team-1",
        title: "Renamed",
      });
      expect(
        client.getCached<Record<string, unknown>>("Task", "task-2")
      ).toMatchObject({ priority: 2, title: "Renamed" });
    } finally {
      await client.stop();
    }
  });
});
