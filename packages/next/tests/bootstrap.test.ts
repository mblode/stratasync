import type { StorageAdapter, StorageMeta } from "@stratasync/client";
import type {
  ModelRegistrySnapshot,
  SchemaDefinition,
  SyncAction,
  Transaction,
} from "@stratasync/core";
import { computeSchemaHash } from "@stratasync/core";

import {
  decodeBootstrapSnapshot,
  deserializeBootstrapSnapshot,
  encodeBootstrapSnapshot,
  isBootstrapSnapshotStale,
  prefetchBootstrap,
  seedStorageFromBootstrap,
  serializeBootstrapSnapshot,
} from "../src/bootstrap";

interface BatchOp {
  type: "put" | "delete";
  modelName: string;
  id?: string;
  data?: Record<string, unknown>;
}

class MemoryStorage implements StorageAdapter {
  meta: StorageMeta;
  opened = false;
  closed = false;
  cleared = false;
  openOptions: {
    name?: string;
    userId?: string;
    version?: number;
    userVersion?: number;
    schema?: SchemaDefinition | ModelRegistrySnapshot;
  } | null = null;
  batches: BatchOp[][] = [];

  constructor(meta: StorageMeta) {
    this.meta = meta;
  }

  open(options: {
    name?: string;
    userId?: string;
    version?: number;
    userVersion?: number;
    schema?: SchemaDefinition | ModelRegistrySnapshot;
  }): Promise<void> {
    this.opened = true;
    this.openOptions = options;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  get<T>(_modelName: string, _id: string): Promise<T | null> {
    return Promise.reject(new Error("Not implemented"));
  }

  getAll<T>(_modelName: string): Promise<T[]> {
    return Promise.reject(new Error("Not implemented"));
  }

  put<T extends Record<string, unknown>>(
    _modelName: string,
    _row: T
  ): Promise<void> {
    return Promise.reject(new Error("Not implemented"));
  }

  delete(_modelName: string, _id: string): Promise<void> {
    return Promise.reject(new Error("Not implemented"));
  }

  getByIndex<T>(
    _modelName: string,
    _indexName: string,
    _key: string
  ): Promise<T[]> {
    return Promise.reject(new Error("Not implemented"));
  }

  writeBatch(ops: BatchOp[]): Promise<void> {
    this.batches.push(ops);
    return Promise.resolve();
  }

  getMeta(): Promise<StorageMeta> {
    return Promise.resolve(this.meta);
  }

  setMeta(meta: Partial<StorageMeta>): Promise<void> {
    this.meta = { ...this.meta, ...meta };
    return Promise.resolve();
  }

  getModelPersistence(
    _modelName: string
  ): ReturnType<StorageAdapter["getModelPersistence"]> {
    return Promise.reject(new Error("Not implemented"));
  }

  setModelPersistence(_modelName: string, _persisted: boolean): Promise<void> {
    return Promise.reject(new Error("Not implemented"));
  }

  getOutbox(): Promise<Transaction[]> {
    return Promise.reject(new Error("Not implemented"));
  }

  addToOutbox(_tx: Transaction): Promise<void> {
    return Promise.reject(new Error("Not implemented"));
  }

  removeFromOutbox(_clientTxId: string): Promise<void> {
    return Promise.reject(new Error("Not implemented"));
  }

  updateOutboxTransaction(
    _clientTxId: string,
    _updates: Partial<Transaction>
  ): Promise<void> {
    return Promise.reject(new Error("Not implemented"));
  }

  hasPartialIndex(
    _modelName: string,
    _indexedKey: string,
    _keyValue: string
  ): Promise<boolean> {
    return Promise.reject(new Error("Not implemented"));
  }

  setPartialIndex(
    _modelName: string,
    _indexedKey: string,
    _keyValue: string
  ): Promise<void> {
    return Promise.reject(new Error("Not implemented"));
  }

  addSyncActions(_actions: SyncAction[]): Promise<void> {
    return Promise.reject(new Error("Not implemented"));
  }

  getSyncActions(
    _afterSyncId?: number,
    _limit?: number
  ): Promise<SyncAction[]> {
    return Promise.reject(new Error("Not implemented"));
  }

  clearSyncActions(): Promise<void> {
    return Promise.reject(new Error("Not implemented"));
  }

  clear(): Promise<void> {
    this.cleared = true;
    return Promise.resolve();
  }

  count(_modelName: string): Promise<number> {
    return Promise.reject(new Error("Not implemented"));
  }
}

const encoder = new TextEncoder();

const createNdjsonResponse = (lines: string[], status = 200): Response => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });

  return new Response(stream, { status });
};

const stubFetch = (lines: string[], status = 200) => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(createNdjsonResponse(lines, status));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe(prefetchBootstrap, () => {
  it("uses firstSyncId from metadata and normalizes lastSyncId", async () => {
    const metadataLine = JSON.stringify({
      _metadata_: {
        firstSyncId: 99,
        lastSyncId: "101",
        subscribedSyncGroups: ["alpha"],
      },
    });

    stubFetch([metadataLine]);

    const snapshot = await prefetchBootstrap({
      endpoint: "https://api.example.com/sync",
      schemaHash: "schema-from-option",
    });

    expect(snapshot.lastSyncId).toBe("101");
    expect(snapshot.firstSyncId).toBe("99");
    expect(snapshot.schemaHash).toBe("schema-from-option");
  });

  it("throws when metadata is missing", async () => {
    const rowLine = JSON.stringify({ __class: "Task", id: "task-1" });
    stubFetch([rowLine]);

    await expect(
      prefetchBootstrap({ endpoint: "https://api.example.com/sync" })
    ).rejects.toThrow("Bootstrap prefetch did not receive metadata");
  });

  it("normalizes sync endpoints and query params", async () => {
    const rowLine = JSON.stringify({ __class: "Task", id: "task-1" });
    const metadataLine = `_metadata_=${JSON.stringify({
      lastSyncId: 1,
      subscribedSyncGroups: [],
    })}`;
    const endLine = JSON.stringify({ rowCount: 1, type: "end" });

    const endpoints = [
      "https://api.example.com/sync",
      "https://api.example.com/sync/bootstrap",
      "https://api.example.com/sync/batch",
      "https://api.example.com/sync/deltas",
    ];

    for (const endpoint of endpoints) {
      const fetchMock = stubFetch([rowLine, metadataLine, endLine]);

      await prefetchBootstrap({
        endpoint,
        groups: ["group-a", "group-b"],
        models: ["Task", "Project"],
        schemaHash: "schema-hash",
      });

      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.pathname).toBe("/sync/bootstrap");
      expect(url.searchParams.get("type")).toBe("full");
      expect(url.searchParams.get("onlyModels")).toBe("Task,Project");
      expect(url.searchParams.get("syncGroups")).toBe("group-a,group-b");
      expect(url.searchParams.get("schemaHash")).toBe("schema-hash");
    }
  });
});

describe("bootstrap snapshot utilities", () => {
  it("roundtrips snapshot payloads without compression", async () => {
    const snapshot = {
      fetchedAt: 1_700_000_000_000,
      firstSyncId: "5",
      groups: ["group-a"],
      lastSyncId: "10",
      rowCount: 1,
      rows: [{ data: { id: "task-1" }, modelName: "Task" }],
      schemaHash: "schema-hash",
      version: 1,
    };

    const payload = await serializeBootstrapSnapshot(snapshot, {
      compress: false,
    });
    expect(payload.encoding).toBe("json");

    const parsed = await deserializeBootstrapSnapshot(payload);
    expect(parsed).toEqual(snapshot);

    const encoded = await encodeBootstrapSnapshot(snapshot, {
      compress: false,
    });
    const decoded = await decodeBootstrapSnapshot(encoded);
    expect(decoded).toEqual(snapshot);
  });

  it("flags stale snapshots using maxAge", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:30.000Z"));

    const snapshot = {
      fetchedAt: Date.now() - 31_000,
      groups: [],
      lastSyncId: "10",
      rows: [],
      schemaHash: "schema-hash",
      version: 1 as const,
    };

    expect(isBootstrapSnapshotStale(snapshot, 30_000)).toBeTruthy();
  });
});

describe(seedStorageFromBootstrap, () => {
  it("short-circuits on schema mismatch", async () => {
    const schema: SchemaDefinition = { models: { Task: { name: "Task" } } };
    const storage = new MemoryStorage({
      clientId: "client-1",
      lastSyncId: "0",
    });

    const result = await seedStorageFromBootstrap({
      schema,
      snapshot: {
        fetchedAt: 1,
        groups: [],
        lastSyncId: "1",
        rows: [],
        schemaHash: "mismatched",
        version: 1,
      },
      storage,
    });

    const localSchemaHash = computeSchemaHash(schema);
    expect(localSchemaHash).not.toBe("mismatched");
    expect(result).toEqual({
      applied: false,
      reason: "schema_mismatch",
      rowCount: 0,
    });
    expect(storage.opened).toBeFalsy();
  });

  it("writes rows and metadata when schema matches", async () => {
    const schema: SchemaDefinition = { models: { Task: { name: "Task" } } };
    const schemaHash = computeSchemaHash(schema);
    const storage = new MemoryStorage({
      clientId: "client-1",
      lastSyncId: "0",
    });

    const result = await seedStorageFromBootstrap({
      batchSize: 2,
      schema,
      snapshot: {
        fetchedAt: 1_700_000_000_000,
        firstSyncId: "4",
        groups: ["group-a"],
        lastSyncId: "10",
        rows: [
          { data: { id: "task-1" }, modelName: "Task" },
          { data: { id: "task-2" }, modelName: "Task" },
          { data: { id: "task-3" }, modelName: "Task" },
        ],
        schemaHash,
        version: 1,
      },
      storage,
    });

    expect(result).toEqual({ applied: true, rowCount: 3 });
    expect(storage.opened).toBeTruthy();
    expect(storage.cleared).toBeTruthy();
    expect(storage.batches.length).toBe(2);
    expect(storage.meta.schemaHash).toBe(schemaHash);
    expect(storage.meta.lastSyncId).toBe("10");
    expect(storage.meta.firstSyncId).toBe("4");
    expect(storage.meta.subscribedSyncGroups).toEqual(["group-a"]);
    expect(storage.meta.bootstrapComplete).toBeTruthy();
    expect(storage.meta.lastSyncAt).toBe(1_700_000_000_000);
    expect(storage.meta.clientId).toBe("client-1");
    expect(storage.closed).toBeTruthy();
  });
});
