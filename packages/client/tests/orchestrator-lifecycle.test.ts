/* oxlint-disable max-classes-per-file -- storage + transport doubles */
/**
 * Stale-continuation races in the orchestrator lifecycle, found by the Lean
 * model in verification/lean/StrataSync/Orchestrator.lean (`bug_*`). Each
 * test interleaves a stop()/restart with an async continuation of an older
 * run and asserts that continuation cannot touch the current run.
 */
import { ModelRegistry, noopReactivityAdapter } from "@stratasync/core";
import type {
  BootstrapMetadata,
  ConnectionState,
  DeltaPacket,
  DeltaSubscription,
  ModelRow,
  SchemaDefinition,
  SubscribeOptions,
  SyncAction,
  Transaction,
} from "@stratasync/core";

import { IdentityMapRegistry } from "../src/identity-map";
import { SyncOrchestrator } from "../src/sync-orchestrator";
import type {
  StorageAdapter,
  StorageMeta,
  TransportAdapter,
} from "../src/types";

const schema: SchemaDefinition = {
  models: {
    Task: {
      fields: { id: {}, title: {} },
      loadStrategy: "instant",
    },
  },
};
const schemaHash = new ModelRegistry(schema).getSchemaHash();

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

const deferred = (): Deferred => {
  let release: (() => void) | null = null;
  // oxlint-disable-next-line avoid-new -- test deferred
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    resolve: () => {
      (release as (() => void) | null)?.();
    },
  };
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
  // oxlint-disable-next-line avoid-new -- let timers/microtasks drain
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
};

class Storage implements StorageAdapter {
  meta: StorageMeta = { lastSyncId: "0" };
  readonly rows = new Map<string, Map<string, Record<string, unknown>>>();
  readonly persisted = new Set<string>();
  /** When set, the next open()/getOutbox() waits on it. */
  openGate: Deferred | null = null;
  outboxGate: Deferred | null = null;
  clearGate: Deferred | null = null;

  async open(): Promise<void> {
    const gate = this.openGate;
    this.openGate = null;
    await gate?.promise;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  get<T>(model: string, id: string): Promise<T | null> {
    return Promise.resolve((this.rows.get(model)?.get(id) as T) ?? null);
  }
  getAll<T>(model: string): Promise<T[]> {
    return Promise.resolve([...(this.rows.get(model)?.values() ?? [])] as T[]);
  }
  put(model: string, row: Record<string, unknown>): Promise<void> {
    const store = this.rows.get(model) ?? new Map();
    store.set(row.id as string, row);
    this.rows.set(model, store);
    return Promise.resolve();
  }
  delete(model: string, id: string): Promise<void> {
    this.rows.get(model)?.delete(id);
    return Promise.resolve();
  }
  getByIndex<T>(): Promise<T[]> {
    return Promise.resolve([]);
  }
  async writeBatch(
    ops: { type: string; modelName: string; data?: Record<string, unknown> }[]
  ): Promise<void> {
    for (const op of ops) {
      if (op.type === "put" && op.data) {
        await this.put(op.modelName, op.data);
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
  getModelPersistence(modelName: string) {
    return Promise.resolve({
      modelName,
      persisted: this.persisted.has(modelName),
    });
  }
  setModelPersistence(modelName: string, persisted: boolean): Promise<void> {
    if (persisted) {
      this.persisted.add(modelName);
    } else {
      this.persisted.delete(modelName);
    }
    return Promise.resolve();
  }
  async getOutbox(): Promise<Transaction[]> {
    const gate = this.outboxGate;
    this.outboxGate = null;
    await gate?.promise;
    return [];
  }
  addToOutbox(): Promise<void> {
    return Promise.resolve();
  }
  removeFromOutbox(): Promise<void> {
    return Promise.resolve();
  }
  updateOutboxTransaction(): Promise<void> {
    return Promise.resolve();
  }
  hasPartialIndex(): Promise<boolean> {
    return Promise.resolve(false);
  }
  setPartialIndex(): Promise<void> {
    return Promise.resolve();
  }
  addSyncActions(_actions: SyncAction[]): Promise<void> {
    return Promise.resolve();
  }
  getSyncActions(): Promise<SyncAction[]> {
    return Promise.resolve([]);
  }
  clearSyncActions(): Promise<void> {
    return Promise.resolve();
  }
  pruneSyncActions(): Promise<void> {
    return Promise.resolve();
  }
  /** Clears at issue time (like an ordered IDB transaction); the ack may lag. */
  async clear(): Promise<void> {
    this.rows.clear();
    const gate = this.clearGate;
    this.clearGate = null;
    await gate?.promise;
  }
  count(model: string): Promise<number> {
    return Promise.resolve(this.rows.get(model)?.size ?? 0);
  }
}

interface LiveSubscription {
  options: SubscribeOptions;
  returned: boolean;
}

class Transport implements TransportAdapter {
  readonly subscriptions: LiveSubscription[] = [];
  readonly listeners = new Set<(state: ConnectionState) => void>();
  bootstrapLastSyncId = "10";
  /** When set, fetchDeltas waits on it (once). */
  fetchGate: Deferred | null = null;

  async *bootstrap(): AsyncGenerator<ModelRow, BootstrapMetadata, unknown> {
    const lastSyncId = this.bootstrapLastSyncId;
    yield { data: { id: "t1", title: `at-${lastSyncId}` }, modelName: "Task" };
    return { lastSyncId };
  }
  async *batchLoad(): AsyncIterable<ModelRow> {
    // no partial models
  }
  mutate(): never {
    throw new Error("not used");
  }
  subscribe(options: SubscribeOptions): DeltaSubscription {
    const entry: LiveSubscription = { options, returned: false };
    this.subscriptions.push(entry);
    const iterator: AsyncIterator<DeltaPacket> = {
      // Never yields: the stream stays open until returned.
      next: () =>
        // oxlint-disable-next-line avoid-new -- pending forever
        new Promise<IteratorResult<DeltaPacket>>(() => {
          // never settles
        }),
      return: () => {
        entry.returned = true;
        return Promise.resolve({
          done: true,
          value: undefined as unknown as DeltaPacket,
        });
      },
    };
    return {
      [Symbol.asyncIterator]: () => iterator,
      unsubscribe: () => {
        entry.returned = true;
      },
    };
  }
  async fetchDeltas(after: string): Promise<DeltaPacket> {
    const gate = this.fetchGate;
    this.fetchGate = null;
    await gate?.promise;
    return { actions: [], hasMore: false, lastSyncId: after };
  }
  getConnectionState(): ConnectionState {
    return "connected";
  }
  onConnectionStateChange(
    listener: (state: ConnectionState) => void
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(state: ConnectionState): void {
    for (const listener of this.listeners) {
      listener(state);
    }
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  live(): LiveSubscription[] {
    return this.subscriptions.filter((entry) => !entry.returned);
  }
}

const createOrchestrator = (storage: Storage, transport: Transport) =>
  new SyncOrchestrator(
    {
      clientId: "client-1",
      reactivity: noopReactivityAdapter,
      schema,
      storage,
      transport,
    },
    new IdentityMapRegistry(noopReactivityAdapter)
  );

const seedWarmStart = async (storage: Storage): Promise<void> => {
  await storage.put("Task", { id: "t1", title: "a" });
  await storage.setMeta({
    bootstrapComplete: true,
    firstSyncId: "5",
    lastSyncId: "5",
    schemaHash,
  });
  await storage.setModelPersistence("Task", true);
};

describe("SyncOrchestrator lifecycle races", () => {
  it("a start() cancelled during privacy reconciliation stays stopped", async () => {
    const storage = new Storage();
    await seedWarmStart(storage);
    // A privacy/group-change re-bootstrap is owed from a previous run.
    await storage.setMeta({ groupChangePending: true });
    const transport = new Transport();
    const orchestrator = createOrchestrator(storage, transport);

    // Hold start() inside applyPendingOutboxTransactions(true), which runs
    // after the last run-token check.
    const outboxGate = deferred();
    storage.outboxGate = outboxGate;
    const starting = orchestrator.start();
    await settle();

    // stop() lands while start() is parked there.
    await orchestrator.reset();
    expect(orchestrator.state).toBe("disconnected");

    outboxGate.resolve();
    await starting;
    await settle();

    // The cancelled run must not revive itself.
    expect(orchestrator.state).toBe("disconnected");
    expect(transport.live()).toHaveLength(0);
  });

  it("a reconnect continuation from a stopped run cannot drive the next run", async () => {
    const storage = new Storage();
    await seedWarmStart(storage);
    const transport = new Transport();
    const orchestrator = createOrchestrator(storage, transport);

    await orchestrator.start();
    await settle();
    expect(orchestrator.state).toBe("syncing");
    expect(transport.live()).toHaveLength(1);

    // Run 1 sees a reconnect; its syncNow() fetch hangs.
    const fetchGate = deferred();
    transport.fetchGate = fetchGate;
    transport.emit("disconnected");
    transport.emit("connected");
    await settle();

    // stop(), then start() run 2, parked in storage.open().
    await orchestrator.reset();
    const openGate = deferred();
    storage.openGate = openGate;
    const run2 = orchestrator.start();
    await settle();
    expect(orchestrator.state).toBe("connecting");
    const subscribeCallsBefore = transport.subscriptions.length;

    // Run 1's reconnect fetch completes while run 2 is still starting.
    fetchGate.resolve();
    await settle();

    // It must not declare run 2 "syncing" or open a subscription for it.
    expect(orchestrator.state).toBe("connecting");
    expect(transport.subscriptions.length).toBe(subscribeCallsBefore);

    openGate.resolve();
    await run2;
    await settle();
    // Run 2 ends with exactly one live stream.
    expect(transport.live()).toHaveLength(1);
    await orchestrator.reset();
  });

  it("a bootstrap from a cancelled run cannot commit into the next run", async () => {
    const storage = new Storage();
    const transport = new Transport();
    const identityMaps = new IdentityMapRegistry(noopReactivityAdapter);
    const orchestrator = new SyncOrchestrator(
      {
        clientId: "client-1",
        reactivity: noopReactivityAdapter,
        schema,
        storage,
        transport,
      },
      identityMaps
    );

    // Run 1 cold-bootstraps a snapshot at sync id 10 and is parked in the
    // storage.clear() that precedes its commit (after its last abort check).
    transport.bootstrapLastSyncId = "10";
    const clearGate = deferred();
    storage.clearGate = clearGate;
    const run1 = orchestrator.start();
    await settle();

    // stop(); run 2 bootstraps a newer snapshot at 20 and finishes.
    await orchestrator.reset();
    transport.bootstrapLastSyncId = "20";
    await orchestrator.start();
    await settle();
    expect(orchestrator.getLastSyncId()).toBe("20");

    // Run 1's commit resumes.
    clearGate.resolve();
    await run1.catch(() => null);
    await settle();

    // Run 2's cursor, rows and in-memory snapshot are untouched.
    expect(orchestrator.getLastSyncId()).toBe("20");
    expect(storage.rows.get("Task")?.get("t1")?.title).toBe("at-20");
    expect(identityMaps.getMap("Task").get("t1")?.title).toBe("at-20");
    await orchestrator.reset();
  });
});
