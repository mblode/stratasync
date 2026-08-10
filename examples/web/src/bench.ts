/**
 * Boot benchmark against real IndexedDB.
 *
 * The Vitest suites assert *counts* (reaction flushes, batched writes) using
 * in-memory fakes. Those fakes can't show the cost this is here to measure:
 * a real IndexedDB `get`/`put` each open their own transaction, so the win
 * from collapsing a delta packet into one `writeBatch` only shows up against
 * a real browser store.
 *
 * Open `/bench.html`, or read `window.__benchResults` after `__benchDone`.
 * Size the run with `?rows=&pageSize=&pages=`.
 */
import type { SyncClient } from "@stratasync/client";
import { createSyncClient } from "@stratasync/client";
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
  SyncId,
  TransactionBatch,
} from "@stratasync/core";
import { ModelRegistry } from "@stratasync/core";
import { createMobXReactivity } from "@stratasync/mobx";
import { createIndexedDbStorage } from "@stratasync/storage-idb";

import "./lib/sync/models";

const params = new URLSearchParams(globalThis.location?.search ?? "");
const ROW_COUNT = Number(params.get("rows") ?? "5000");
const DELTA_PAGE_SIZE = Number(params.get("pageSize") ?? "1000");
const DELTA_PAGE_COUNT = Number(params.get("pages") ?? "4");
const GROUP_ID = "bench-group";

interface BenchResult {
  name: string;
  ms: number;
  detail: string;
}

const results: BenchResult[] = [];

/**
 * Chrome-only, and only granular to a few hundred KB, but enough to size the
 * identity map: `instant` models are never evicted, so their full row set is
 * resident for the life of the session.
 */
const heapMb = (): number | null => {
  const mem = (
    performance as unknown as { memory?: { usedJSHeapSize: number } }
  ).memory;
  return mem ? Math.round((mem.usedJSHeapSize / 1024 / 1024) * 10) / 10 : null;
};

const noop = (): void => {
  // Nothing to unsubscribe from: the stub transport never changes state.
};

const wait = (ms: number): Promise<void> =>
  // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A promise that never settles, for a subscription that stays open. */
const pending = <T>(): Promise<T> =>
  // oxlint-disable-next-line avoid-new -- intentionally never settles
  new Promise<T>(() => {
    // No resolve or reject: the stream is open for the whole benchmark.
  });

const makeRow = (i: number): Record<string, unknown> => ({
  completed: i % 3 === 0,
  createdAt: 1_700_000_000_000 + i,
  groupId: GROUP_ID,
  id: `todo-${i}`,
  title: `Todo ${i}`,
});

/**
 * Transport stub: no server. Bootstrap streams nothing (rows are seeded into
 * IndexedDB directly), and `fetchDeltas` serves a fixed multi-page backlog so
 * the catch-up path is exercised deterministically.
 */
const createBenchTransport = (deltaPages: DeltaPacket[] = []) => {
  let fetchCount = 0;

  return {
    // oxlint-disable-next-line require-yield -- no lazy loads in this benchmark
    async *batchLoad(_options: BatchLoadOptions): AsyncGenerator<ModelRow> {
      await Promise.resolve();
    },

    // oxlint-disable-next-line require-yield -- bootstrap streams no rows here
    async *bootstrap(
      _options: BootstrapOptions
    ): AsyncGenerator<ModelRow, BootstrapMetadata, unknown> {
      await Promise.resolve();
      return { lastSyncId: "1", subscribedSyncGroups: [GROUP_ID] };
    },

    close: (): Promise<void> => Promise.resolve(),

    /** Number of `fetchDeltas` round trips, i.e. catch-up pages requested. */
    fetchCount: (): number => fetchCount,

    fetchDeltas: (after: SyncId): Promise<DeltaPacket> => {
      fetchCount += 1;
      const page = deltaPages.find((p) =>
        p.actions.some((a) => Number(a.id) > Number(after))
      );
      return Promise.resolve(
        page ?? { actions: [], hasMore: false, lastSyncId: after }
      );
    },

    getConnectionState: (): ConnectionState => "connected",

    mutate: (_batch: TransactionBatch): Promise<MutateResult> =>
      Promise.resolve({ lastSyncId: "1", results: [], success: true }),

    onConnectionStateChange: (
      _callback: (state: ConnectionState) => void
    ): (() => void) => noop,

    // An open stream that never yields: catch-up is what we're timing.
    subscribe: (_options: SubscribeOptions): DeltaSubscription =>
      ({
        [Symbol.asyncIterator]: () => ({
          next: () => pending<IteratorResult<DeltaPacket>>(),
        }),
      }) as DeltaSubscription,
  };
};

type BenchTransport = ReturnType<typeof createBenchTransport>;

const buildDeltaPages = (): DeltaPacket[] => {
  const pages: DeltaPacket[] = [];
  let syncId = 1;
  for (let page = 0; page < DELTA_PAGE_COUNT; page += 1) {
    const actions: SyncAction[] = [];
    for (let i = 0; i < DELTA_PAGE_SIZE; i += 1) {
      syncId += 1;
      actions.push({
        action: "U",
        data: { title: `Delta ${syncId}` },
        id: String(syncId),
        modelId: `todo-${i}`,
        modelName: "Todo",
      });
    }
    pages.push({
      actions,
      hasMore: page < DELTA_PAGE_COUNT - 1,
      lastSyncId: String(syncId),
    });
  }
  return pages;
};

const makeClient = (
  dbName: string,
  transport: BenchTransport
): { client: SyncClient; flushes: () => number } => {
  const mobx = createMobXReactivity();
  let depth = 0;
  let flushes = 0;
  const reactivity = {
    ...mobx,
    runInAction<T>(fn: () => T): T {
      if (depth === 0) {
        flushes += 1;
      }
      depth += 1;
      try {
        return mobx.runInAction(fn);
      } finally {
        depth -= 1;
      }
    },
  };

  const client = createSyncClient({
    dbName,
    groups: [GROUP_ID],
    reactivity,
    schema: ModelRegistry.snapshot(),
    storage: createIndexedDbStorage(),
    transport: transport as unknown as Parameters<
      typeof createSyncClient
    >[0]["transport"],
    userId: "bench-user",
  });

  return { client, flushes: () => flushes };
};

const seed = async (dbName: string): Promise<void> => {
  const storage = createIndexedDbStorage();
  await storage.open({ name: dbName, schema: ModelRegistry.snapshot() });
  await storage.clear();
  await storage.writeBatch(
    Array.from({ length: ROW_COUNT }, (_, i) => ({
      data: makeRow(i),
      modelName: "Todo",
      type: "put" as const,
    }))
  );
  await storage.setModelPersistence("Todo", true);
  await storage.setMeta({
    bootstrapComplete: true,
    lastSyncId: "1",
    schemaHash: new ModelRegistry(ModelRegistry.snapshot()).getSchemaHash(),
    subscribedSyncGroups: [GROUP_ID],
  });
  await storage.close();
};

const run = async (): Promise<void> => {
  const dbName = `bench-${Date.now()}`;

  // 1. Warm start: hydrate ROW_COUNT rows from IndexedDB into identity maps.
  await seed(dbName);
  const warm = makeClient(dbName, createBenchTransport());
  const heapBefore = heapMb();
  const warmStart = performance.now();
  await warm.client.start();
  const warmMs = performance.now() - warmStart;
  const hydrated = warm.client.getIdentityMap("Todo").size;
  const heapAfter = heapMb();
  const heapDelta =
    heapBefore !== null && heapAfter !== null
      ? ` (+${Math.round((heapAfter - heapBefore) * 10) / 10} MB heap, ${heapAfter} MB total)`
      : "";
  await warm.client.stop();
  results.push({
    detail: `${hydrated} rows, ${warm.flushes()} top-level reaction flushes${heapDelta}`,
    ms: warmMs,
    name: `Warm start (${ROW_COUNT} rows)`,
  });

  // 2. Catch-up: apply a DELTA_PAGE_COUNT-page backlog over the same rows.
  const catchUpDb = `bench-catchup-${Date.now()}`;
  await seed(catchUpDb);
  const transport = createBenchTransport(buildDeltaPages());
  const catchUp = makeClient(catchUpDb, transport);
  const catchUpStart = performance.now();
  await catchUp.client.start();
  while (
    Number(catchUp.client.lastSyncId) <
    DELTA_PAGE_SIZE * DELTA_PAGE_COUNT
  ) {
    await wait(10);
  }
  const catchUpMs = performance.now() - catchUpStart;
  await catchUp.client.stop();
  results.push({
    detail: `${DELTA_PAGE_COUNT} pages x ${DELTA_PAGE_SIZE} actions, ${catchUp.flushes()} top-level reaction flushes, ${transport.fetchCount()} fetches`,
    ms: catchUpMs,
    name: "Multi-page catch-up",
  });

  const status = document.querySelector("#status");
  if (status) {
    status.textContent = "Done.";
  }
  const table = [
    "<table><tr><th>Benchmark</th><th>ms</th><th>Detail</th></tr>",
    ...results.map(
      (r) =>
        `<tr><td>${r.name}</td><td>${r.ms.toFixed(1)}</td><td>${r.detail}</td></tr>`
    ),
    "</table>",
  ].join("");
  const container = document.querySelector("#results");
  if (container) {
    container.innerHTML = table;
  }

  (window as unknown as Record<string, unknown>).__benchResults = results;
  (window as unknown as Record<string, unknown>).__benchDone = true;
};

try {
  await run();
} catch (error) {
  const status = document.querySelector("#status");
  if (status) {
    status.textContent = `Failed: ${String(error)}`;
  }
  (window as unknown as Record<string, unknown>).__benchError = String(error);
  (window as unknown as Record<string, unknown>).__benchDone = true;
}
