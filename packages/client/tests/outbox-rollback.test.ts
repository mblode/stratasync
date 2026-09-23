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
import { OutboxManager } from "../src/outbox-manager";
import type {
  ClearStorageOptions,
  ModelPersistenceMeta,
  StorageAdapter,
  StorageMeta,
  SyncClientEvent,
  TransportAdapter,
} from "../src/types";

/**
 * Storage double with IndexedDB's copy semantics: every outbox read returns a
 * structured clone and every write stores one, so no object is shared between
 * the outbox manager, the rebase pass and storage.
 */
class CloningStorage implements StorageAdapter {
  private readonly data = new Map<
    string,
    Map<string, Record<string, unknown>>
  >();
  private meta: StorageMeta = { lastSyncId: "0" };
  private readonly modelPersistence = new Map<string, boolean>();
  private outbox: Transaction[] = [];
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
  private store(modelName: string): Map<string, Record<string, unknown>> {
    const existing = this.data.get(modelName);
    if (existing) {
      return existing;
    }
    const created = new Map<string, Record<string, unknown>>();
    this.data.set(modelName, created);
    return created;
  }
  get<T>(modelName: string, id: string): Promise<T | null> {
    const row = this.data.get(modelName)?.get(id);
    return Promise.resolve(row ? (structuredClone(row) as T) : null);
  }
  getAll<T>(modelName: string): Promise<T[]> {
    const rows = [...(this.data.get(modelName)?.values() ?? [])];
    return Promise.resolve(rows.map((row) => structuredClone(row) as T));
  }
  put<T extends Record<string, unknown>>(
    modelName: string,
    row: T
  ): Promise<void> {
    const { id } = row;
    if (typeof id !== "string") {
      throw new TypeError(`Missing id for ${modelName}`);
    }
    this.store(modelName).set(id, structuredClone(row));
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
    const rows = [...(this.data.get(modelName)?.values() ?? [])];
    return Promise.resolve(
      rows
        .filter((row) => row[indexName] === key)
        .map((row) => structuredClone(row) as T)
    );
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
    return Promise.resolve(structuredClone(this.meta));
  }
  setMeta(meta: Partial<StorageMeta>): Promise<void> {
    this.meta = { ...this.meta, ...structuredClone(meta) };
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
    return Promise.resolve(structuredClone(this.outbox));
  }
  addToOutbox(tx: Transaction): Promise<void> {
    this.outbox.push(structuredClone(tx));
    return Promise.resolve();
  }
  removeFromOutbox(clientTxId: string): Promise<void> {
    this.outbox = this.outbox.filter((tx) => tx.clientTxId !== clientTxId);
    return Promise.resolve();
  }
  updateOutboxTransaction(
    clientTxId: string,
    updates: Partial<Transaction>
  ): Promise<void> {
    this.outbox = this.outbox.map((tx) =>
      tx.clientTxId === clientTxId ? { ...tx, ...structuredClone(updates) } : tx
    );
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
    this.syncActions.push(...structuredClone(actions));
    return Promise.resolve();
  }
  getSyncActions(afterSyncId?: string, limit?: number): Promise<SyncAction[]> {
    const filtered = afterSyncId
      ? this.syncActions.filter((a) => a.id > afterSyncId)
      : [...this.syncActions];
    return Promise.resolve(
      structuredClone(
        typeof limit === "number" ? filtered.slice(0, limit) : filtered
      )
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
      this.outbox = [];
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

interface HeldMutation {
  batch: TransactionBatch;
  respond: (result: MutateResult) => void;
}

/** Transport whose mutate calls stay in flight until the test answers them. */
class HoldingTransport implements TransportAdapter {
  readonly held: HeldMutation[] = [];
  private readonly deltaQueue = new AsyncQueue<DeltaPacket>();
  private readonly rows: ModelRow[];

  constructor(rows: ModelRow[]) {
    this.rows = rows;
  }

  bootstrap(
    _options: BootstrapOptions
  ): AsyncGenerator<ModelRow, BootstrapMetadata, unknown> {
    const { rows } = this;
    return (async function* generate() {
      for (const row of rows) {
        yield row;
      }
      return { lastSyncId: "10", subscribedSyncGroups: ["team-1"] };
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
  private released = false;

  mutate(batch: TransactionBatch): Promise<MutateResult> {
    // oxlint-disable-next-line avoid-new -- held until the test responds
    const sent = new Promise<MutateResult>((resolve) => {
      let settled = false;
      this.held.push({
        batch,
        respond: (result) => {
          if (!settled) {
            settled = true;
            resolve(result);
          }
        },
      });
    });
    if (this.released) {
      this.release();
    }
    return sent;
  }

  /** Answers every mutation in flight, and any sent later, with success. */
  release(): void {
    this.released = true;
    for (const { batch, respond } of this.held) {
      respond({
        results: batch.transactions.map((tx) => ({
          clientTxId: tx.clientTxId,
          success: true,
        })),
        success: true,
      });
    }
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
  fetchDeltas(after: string): Promise<DeltaPacket> {
    return Promise.resolve({ actions: [], lastSyncId: after });
  }
  getConnectionState(): ConnectionState {
    return "connected";
  }
  onConnectionStateChange(
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback: (state: ConnectionState) => void
  ): () => void {
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback("connected");
    return () => {
      /* noop */
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
  },
};

const seedRows: ModelRow[] = [
  {
    data: { id: "task-1", priority: 1, teamId: "team-1", title: "Seed" },
    modelName: "Task",
  },
];

const waitUntil = async (
  condition: () => boolean,
  message: string
): Promise<void> => {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(message);
    }
    // oxlint-disable-next-line avoid-new -- polling helper
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
};

const waitForSync = (
  client: ReturnType<typeof createSyncClient>,
  expectedSyncId: string
): Promise<void> =>
  // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
  new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for sync ${expectedSyncId}`)),
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

const reject = (held: HeldMutation, error: string): void => {
  held.respond({
    results: held.batch.transactions.map((tx) => ({
      clientTxId: tx.clientTxId,
      error,
      success: false,
    })),
    success: false,
  });
};

const setup = (options: { rebaseStrategy?: "client-wins" } = {}) => {
  const storage = new CloningStorage();
  const transport = new HoldingTransport(seedRows);
  const client = createSyncClient({
    // Batched: the timer sends outside the state lock, so a delta can be
    // applied while the send is in flight.
    batchDelay: 1,
    batchMutations: true,
    reactivity: noopReactivityAdapter,
    schema,
    storage,
    transport,
    ...options,
  });
  const events: SyncClientEvent[] = [];
  client.onEvent((event) => events.push(event));
  return { client, events, storage, transport };
};

const title = (client: ReturnType<typeof createSyncClient>): unknown =>
  client.getCached<Record<string, unknown>>("Task", "task-1")?.title;

describe("outbox rollback", () => {
  it("rolls a rejected in-flight update back to its rebased original under copying storage", async () => {
    const { client, storage, transport } = setup({
      rebaseStrategy: "client-wins",
    });
    try {
      await client.start();
      await client.update("Task", "task-1", { title: "Local" });
      await waitUntil(() => transport.held.length === 1, "no send");

      // Another client's write to the same field lands while ours is in
      // flight. Rebase moves our rollback snapshot to the server's value.
      const synced = waitForSync(client, "20");
      transport.emitDelta({
        actions: [
          {
            action: "U",
            clientId: "other-client",
            data: { id: "task-1", title: "Server" },
            id: "20",
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        lastSyncId: "20",
      });
      await synced;
      const [persisted] = await storage.getOutbox();
      expect(persisted?.original).toEqual({ title: "Server" });
      expect(title(client)).toBe("Local");

      const [held] = transport.held;
      if (!held) {
        throw new Error("Expected a held mutation");
      }
      reject(held, "forbidden");
      await waitUntil(() => title(client) !== "Local", "no rollback");

      // Not "Seed": that value was overwritten on the server at sync id 20.
      expect(title(client)).toBe("Server");
    } finally {
      transport.release();
      await client.stop();
    }
  });

  it("does not report an in-flight write as rejected when an earlier server write conflicts", async () => {
    const { client, events, transport } = setup();
    try {
      await client.start();
      await client.update("Task", "task-1", { title: "Local" });
      await waitUntil(() => transport.held.length === 1, "no send");

      // Sequenced before our write (whose echo is not in this packet): the
      // server applies ours after it, so ours is the last write.
      const synced = waitForSync(client, "20");
      transport.emitDelta({
        actions: [
          {
            action: "U",
            clientId: "other-client",
            data: { id: "task-1", title: "Server" },
            id: "20",
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        lastSyncId: "20",
      });
      await synced;

      expect(events.filter((e) => e.type === "mutationRejected")).toEqual([]);
      expect(title(client)).toBe("Local");

      const [held] = transport.held;
      if (!held) {
        throw new Error("Expected a held mutation");
      }
      const [tx] = held.batch.transactions;
      if (!tx) {
        throw new Error("Expected a sent transaction");
      }
      held.respond({
        lastSyncId: "21",
        results: [{ clientTxId: tx.clientTxId, success: true, syncId: "21" }],
        success: true,
      });
      const echoed = waitForSync(client, "21");
      transport.emitDelta({
        actions: [
          {
            action: "U",
            clientId: tx.clientId,
            clientTxId: tx.clientTxId,
            data: { id: "task-1", title: "Local" },
            id: "21",
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        lastSyncId: "21",
      });
      await echoed;

      expect(events.filter((e) => e.type === "mutationRejected")).toEqual([]);
      expect(title(client)).toBe("Local");
    } finally {
      transport.release();
      await client.stop();
    }
  });

  it("does not resurrect a partial row when an update is rejected after the row is gone", async () => {
    const { client, events, transport } = setup();
    try {
      await client.start();
      await client.update("Task", "task-1", { title: "Local" });
      await waitUntil(() => transport.held.length === 1, "no send");

      // Another client deletes the row before our update reaches the server.
      const synced = waitForSync(client, "20");
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
        ],
        lastSyncId: "20",
      });
      await synced;
      expect(client.getCached("Task", "task-1")).toBeNull();

      const [held] = transport.held;
      if (!held) {
        throw new Error("Expected a held mutation");
      }
      reject(held, "not found");
      await waitUntil(
        () => events.some((e) => e.type === "mutationRejected"),
        "no rejection"
      );

      // The old rollback re-inserted `original` ({ title: "Seed" }) as a
      // ghost row with none of the model's other fields.
      expect(client.getCached("Task", "task-1")).toBeNull();
    } finally {
      transport.release();
      await client.stop();
    }
  });
});

describe("outbox discard", () => {
  it("never sends a batched transaction discarded before its batch is flushed", async () => {
    const storage = new CloningStorage();
    const mutate = vi.fn((batch: TransactionBatch) =>
      Promise.resolve<MutateResult>({
        lastSyncId: "0",
        results: batch.transactions.map((tx) => ({
          clientTxId: tx.clientTxId,
          success: true,
        })),
        success: true,
      })
    );
    const transport = new HoldingTransport([]);
    transport.mutate = mutate;
    const manager = new OutboxManager({
      batchDelay: 60_000,
      clientId: "client-1",
      storage,
      transport,
    });

    const dropped = await manager.update(
      "Task",
      "task-1",
      { title: "Dropped" },
      { title: "Seed" }
    );
    const kept = await manager.update(
      "Task",
      "task-2",
      { title: "Kept" },
      { title: "Seed" }
    );
    // A server-wins rebase conflict drops the queued transaction.
    await manager.discardTransaction(dropped.clientTxId);
    await manager.flush();

    const sent = mutate.mock.calls.flatMap(([batch]) =>
      batch.transactions.map((tx) => tx.clientTxId)
    );
    expect(sent).toEqual([kept.clientTxId]);
  });

  it("never sends a transaction discarded while its batch waits behind an in-flight send", async () => {
    const storage = new CloningStorage();
    const transport = new HoldingTransport([]);
    const manager = new OutboxManager({
      batchDelay: 60_000,
      clientId: "client-1",
      storage,
      transport,
    });

    const first = await manager.update(
      "Task",
      "task-1",
      { title: "First" },
      { title: "Seed" }
    );
    const flushedFirst = manager.flush();
    await waitUntil(() => transport.held.length === 1, "no first send");

    const dropped = await manager.update(
      "Task",
      "task-2",
      { title: "Dropped" },
      { title: "Seed" }
    );
    // Dispatched onto the send queue, behind the in-flight first batch.
    const flushedSecond = manager.flush();
    await manager.discardTransaction(dropped.clientTxId);

    transport.release();
    await Promise.all([flushedFirst, flushedSecond]);

    const sent = transport.held.flatMap(({ batch }) =>
      batch.transactions.map((tx) => tx.clientTxId)
    );
    expect(sent).toEqual([first.clientTxId]);
  });
});
