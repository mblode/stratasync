import type { SyncAction, Transaction } from "@stratasync/core";

import { LocalStorageAdapter } from "../src/adapter.js";

/**
 * Minimal in-memory Storage shim for Node.js tests
 */
class MemoryStorage implements Storage {
  private readonly store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    const keys = [...this.store.keys()];
    return keys[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

const makeTx = (overrides: Partial<Transaction> = {}): Transaction => ({
  action: "I",
  clientId: "client-1",
  clientTxId: "tx-1",
  createdAt: Date.now(),
  modelId: "todo-1",
  modelName: "Todo",
  payload: { title: "Test" },
  retryCount: 0,
  state: "queued",
  ...overrides,
});

describe(LocalStorageAdapter, () => {
  let adapter: LocalStorageAdapter;
  let storage: MemoryStorage;

  beforeEach(async () => {
    storage = new MemoryStorage();
    adapter = new LocalStorageAdapter({ prefix: "test", storage });
    await adapter.open({ name: "testdb" });
  });

  describe("CRUD operations", () => {
    it("should put and get a record", async () => {
      await adapter.put("Todo", { id: "1", title: "Buy milk" });
      const result = await adapter.get<{ id: string; title: string }>(
        "Todo",
        "1"
      );
      expect(result).toEqual({ id: "1", title: "Buy milk" });
    });

    it("should return null for missing record", async () => {
      const result = await adapter.get("Todo", "nonexistent");
      expect(result).toBeNull();
    });

    it("should getAll records for a model", async () => {
      await adapter.put("Todo", { id: "1", title: "A" });
      await adapter.put("Todo", { id: "2", title: "B" });
      const results = await adapter.getAll<{ id: string; title: string }>(
        "Todo"
      );
      expect(results).toHaveLength(2);
    });

    it("should delete a record", async () => {
      await adapter.put("Todo", { id: "1", title: "A" });
      await adapter.delete("Todo", "1");
      const result = await adapter.get("Todo", "1");
      expect(result).toBeNull();
    });

    it("should update existing record on put", async () => {
      await adapter.put("Todo", { id: "1", title: "Old" });
      await adapter.put("Todo", { id: "1", title: "New" });
      const result = await adapter.get<{ id: string; title: string }>(
        "Todo",
        "1"
      );
      expect(result?.title).toBe("New");
    });

    it("should count records", async () => {
      await adapter.put("Todo", { id: "1", title: "A" });
      await adapter.put("Todo", { id: "2", title: "B" });
      const count = await adapter.count("Todo");
      expect(count).toBe(2);
    });

    it("should return 0 for empty model count", async () => {
      const count = await adapter.count("Empty");
      expect(count).toBe(0);
    });
  });

  describe("getByIndex", () => {
    it("should filter records by index field value", async () => {
      await adapter.put("Todo", { id: "1", status: "done", title: "A" });
      await adapter.put("Todo", { id: "2", status: "pending", title: "B" });
      await adapter.put("Todo", { id: "3", status: "done", title: "C" });

      const results = await adapter.getByIndex<{
        id: string;
        status: string;
      }>("Todo", "status", "done");
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.status === "done")).toBeTruthy();
    });
  });

  describe("writeBatch", () => {
    it("should apply put and delete operations atomically", async () => {
      await adapter.put("Todo", { id: "1", title: "Delete me" });

      await adapter.writeBatch([
        { data: { id: "2", title: "New" }, modelName: "Todo", type: "put" },
        { id: "1", modelName: "Todo", type: "delete" },
      ]);

      const deleted = await adapter.get("Todo", "1");
      expect(deleted).toBeNull();

      const created = await adapter.get<{ id: string; title: string }>(
        "Todo",
        "2"
      );
      expect(created?.title).toBe("New");
    });
  });

  describe("metadata", () => {
    it("should return default meta when empty", async () => {
      const meta = await adapter.getMeta();
      expect(meta.lastSyncId).toBe("0");
    });

    it("should set and merge meta", async () => {
      await adapter.setMeta({ clientId: "abc", lastSyncId: "5" });
      const meta = await adapter.getMeta();
      expect(meta.lastSyncId).toBe("5");
      expect(meta.clientId).toBe("abc");

      await adapter.setMeta({ lastSyncId: "10" });
      const updated = await adapter.getMeta();
      expect(updated.lastSyncId).toBe("10");
      expect(updated.clientId).toBe("abc");
    });

    it("should handle subscribedSyncGroups", async () => {
      await adapter.setMeta({ subscribedSyncGroups: ["group-a"] });
      const meta = await adapter.getMeta();
      expect(meta.subscribedSyncGroups).toEqual(["group-a"]);
    });
  });

  describe("model persistence", () => {
    it("should default to not persisted", async () => {
      const result = await adapter.getModelPersistence("Todo");
      expect(result.persisted).toBeFalsy();
      expect(result.modelName).toBe("Todo");
    });

    it("should set model as persisted", async () => {
      await adapter.setModelPersistence("Todo", true);
      const result = await adapter.getModelPersistence("Todo");
      expect(result.persisted).toBeTruthy();
      expect(result.updatedAt).toBeDefined();
    });
  });

  describe("outbox", () => {
    it("should add and get transactions", async () => {
      const tx = makeTx();
      await adapter.addToOutbox(tx);
      const outbox = await adapter.getOutbox();
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.clientTxId).toBe("tx-1");
    });

    it("should remove transactions", async () => {
      await adapter.addToOutbox(makeTx({ clientTxId: "tx-1" }));
      await adapter.addToOutbox(makeTx({ clientTxId: "tx-2" }));
      await adapter.removeFromOutbox("tx-1");
      const outbox = await adapter.getOutbox();
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.clientTxId).toBe("tx-2");
    });

    it("should update a transaction", async () => {
      await adapter.addToOutbox(makeTx());
      await adapter.updateOutboxTransaction("tx-1", { state: "sent" });
      const outbox = await adapter.getOutbox();
      expect(outbox[0]?.state).toBe("sent");
    });
  });

  describe("partial indexes", () => {
    it("should track partial index entries", async () => {
      const has = await adapter.hasPartialIndex("Todo", "status", "done");
      expect(has).toBeFalsy();

      await adapter.setPartialIndex("Todo", "status", "done");
      const hasAfter = await adapter.hasPartialIndex("Todo", "status", "done");
      expect(hasAfter).toBeTruthy();
    });
  });

  describe("sync actions", () => {
    it("should add and retrieve sync actions", async () => {
      const actions: SyncAction[] = [
        {
          action: "I",
          data: { title: "A" },
          id: "2",
          modelId: "todo-1",
          modelName: "Todo",
        },
        {
          action: "I",
          data: { title: "B" },
          id: "1",
          modelId: "todo-2",
          modelName: "Todo",
        },
      ];
      await adapter.addSyncActions(actions);

      const result = await adapter.getSyncActions("0");
      expect(result).toHaveLength(2);
      // Should be sorted by sync ID
      expect(result[0]?.id).toBe("1");
      expect(result[1]?.id).toBe("2");
    });

    it("should filter sync actions by afterSyncId", async () => {
      const actions: SyncAction[] = [
        {
          action: "I",
          data: {},
          id: "1",
          modelId: "t1",
          modelName: "Todo",
        },
        {
          action: "I",
          data: {},
          id: "3",
          modelId: "t2",
          modelName: "Todo",
        },
      ];
      await adapter.addSyncActions(actions);

      const result = await adapter.getSyncActions("1");
      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe("3");
    });

    it("should respect limit", async () => {
      const actions: SyncAction[] = Array.from({ length: 5 }, (_, i) => ({
        action: "I" as const,
        data: {},
        id: String(i + 1),
        modelId: `t${String(i)}`,
        modelName: "Todo",
      }));
      await adapter.addSyncActions(actions);

      const result = await adapter.getSyncActions("0", 2);
      expect(result).toHaveLength(2);
    });

    it("should clear sync actions", async () => {
      await adapter.addSyncActions([
        {
          action: "I",
          data: {},
          id: "1",
          modelId: "t1",
          modelName: "Todo",
        },
      ]);
      await adapter.clearSyncActions();
      const result = await adapter.getSyncActions();
      expect(result).toHaveLength(0);
    });
  });

  describe("clear", () => {
    it("should clear all data", async () => {
      await adapter.put("Todo", { id: "1", title: "A" });
      await adapter.setMeta({ lastSyncId: "5" });
      await adapter.addToOutbox(makeTx());
      await adapter.clear();

      const todos = await adapter.getAll("Todo");
      expect(todos).toHaveLength(0);
      const meta = await adapter.getMeta();
      expect(meta.lastSyncId).toBe("0");
      const outbox = await adapter.getOutbox();
      expect(outbox).toHaveLength(0);
    });

    it("should preserve outbox when requested", async () => {
      await adapter.put("Todo", { id: "1", title: "A" });
      await adapter.addToOutbox(makeTx());
      await adapter.clear({ preserveOutbox: true });

      const todos = await adapter.getAll("Todo");
      expect(todos).toHaveLength(0);
      const outbox = await adapter.getOutbox();
      expect(outbox).toHaveLength(1);
    });
  });

  describe("isolation", () => {
    it("should isolate data between different db names", async () => {
      await adapter.put("Todo", { id: "1", title: "DB1" });

      const adapter2 = new LocalStorageAdapter({ prefix: "test", storage });
      await adapter2.open({ name: "otherdb" });
      await adapter2.put("Todo", { id: "1", title: "DB2" });

      const fromDb1 = await adapter.get<{ id: string; title: string }>(
        "Todo",
        "1"
      );
      const fromDb2 = await adapter2.get<{ id: string; title: string }>(
        "Todo",
        "1"
      );

      expect(fromDb1?.title).toBe("DB1");
      expect(fromDb2?.title).toBe("DB2");
    });
  });
});
