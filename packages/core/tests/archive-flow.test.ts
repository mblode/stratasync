/* oxlint-disable no-import-node-test -- uses Node test runner */
import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDeltas,
  captureArchiveState,
  createArchivePayload,
  createArchiveTransaction,
  createUnarchivePatch,
  createUnarchivePayload,
  createUnarchiveTransaction,
  createUndoTransaction,
  readArchivedAt,
  rebaseTransactions,
} from "../src/index";

const withMockedNow = <T>(value: number, run: () => T): T => {
  const originalNow = Date.now;
  Date.now = () => value;

  try {
    return run();
  } finally {
    Date.now = originalNow;
  }
};

test("archive helpers normalize archive state consistently", () => {
  const snapshot = captureArchiveState({
    archivedAt: 123,
    title: "Task",
  });

  assert.deepEqual(snapshot, { archivedAt: 123 });
  assert.deepEqual(captureArchiveState({ archivedAt: "not-a-date" }), {
    archivedAt: null,
  });
  assert.equal(
    readArchivedAt({ archivedAt: "2024-01-02T03:04:05.000Z" }),
    Date.parse("2024-01-02T03:04:05.000Z")
  );

  withMockedNow(456, () => {
    assert.deepEqual(createArchivePayload(), { archivedAt: 456 });
  });

  assert.deepEqual(createUnarchivePatch(), { archivedAt: null });
  assert.deepEqual(createUnarchivePayload(), {});
  assert.equal(
    readArchivedAt({ archivedAt: "2026-03-14T00:00:00.000Z" }),
    Date.parse("2026-03-14T00:00:00.000Z")
  );
});

test("archive transactions invert cleanly for undo", () => {
  const archiveTx = createArchiveTransaction("client-1", "Task", "task-1", {
    archivedAt: 789,
    original: createUnarchivePatch(),
  });
  const archiveUndo = createUndoTransaction(archiveTx);

  assert.equal(archiveUndo?.action, "V");
  assert.deepEqual(archiveUndo?.payload, {});
  assert.deepEqual(archiveUndo?.original, { archivedAt: 789 });

  const unarchiveTx = createUnarchiveTransaction("client-1", "Task", "task-1", {
    original: { archivedAt: 789 },
  });
  const unarchiveUndo = withMockedNow(999, () =>
    createUndoTransaction(unarchiveTx)
  );

  assert.equal(unarchiveUndo?.action, "A");
  assert.deepEqual(unarchiveUndo?.payload, { archivedAt: 789 });
  assert.deepEqual(unarchiveUndo?.original, { archivedAt: null });
});

test("applyDeltas preserves archive fallback and unarchive clearing", async () => {
  const rows = new Map<string, Record<string, unknown>>([
    ["Task:task-1", { id: "task-1", title: "Task 1" }],
  ]);
  const target = {
    delete(modelName: string, id: string): void {
      rows.delete(`${modelName}:${id}`);
    },
    get(modelName: string, id: string): Record<string, unknown> | null {
      return rows.get(`${modelName}:${id}`) ?? null;
    },
    patch(
      modelName: string,
      id: string,
      changes: Record<string, unknown>
    ): void {
      const key = `${modelName}:${id}`;
      const existing = rows.get(key);
      if (!existing) {
        return;
      }
      rows.set(key, { ...existing, ...changes });
    },
    put(modelName: string, id: string, data: Record<string, unknown>): void {
      rows.set(`${modelName}:${id}`, { ...data });
    },
  };
  const registry = {
    hasModel(modelName: string): boolean {
      return modelName === "Task";
    },
  };

  await withMockedNow(1234, async () => {
    await applyDeltas(
      {
        actions: [
          {
            action: "A",
            data: {},
            id: "1",
            modelId: "task-1",
            modelName: "Task",
          },
          {
            action: "V",
            data: {},
            id: "2",
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        lastSyncId: "2",
      },
      target,
      registry
    );
  });

  assert.equal(rows.get("Task:task-1")?.archivedAt, null);
});

test("applyDeltas upserts archive state when the row is missing", async () => {
  const rows = new Map<string, Record<string, unknown>>();
  const target = {
    delete(modelName: string, id: string): void {
      rows.delete(`${modelName}:${id}`);
    },
    get(modelName: string, id: string): Record<string, unknown> | null {
      return rows.get(`${modelName}:${id}`) ?? null;
    },
    patch(
      modelName: string,
      id: string,
      changes: Record<string, unknown>
    ): void {
      const key = `${modelName}:${id}`;
      const existing = rows.get(key) ?? {};
      rows.set(key, { ...existing, ...changes });
    },
    put(modelName: string, id: string, data: Record<string, unknown>): void {
      rows.set(`${modelName}:${id}`, { ...data });
    },
  };
  const registry = {
    hasModel(modelName: string): boolean {
      return modelName === "Task";
    },
  };

  await applyDeltas(
    {
      actions: [
        {
          action: "A",
          data: { title: "Archived task" },
          id: "1",
          modelId: "task-2",
          modelName: "Task",
        },
      ],
      lastSyncId: "1",
    },
    target,
    registry
  );

  const upsertedRow = rows.get("Task:task-2");
  assert.equal(upsertedRow?.title, "Archived task");
  assert.equal(typeof upsertedRow?.archivedAt, "number");
  assert.ok(
    (upsertedRow?.archivedAt as number) > 0,
    "archivedAt should be a positive timestamp"
  );
});

test("applyDeltas advances sync state for unknown models", async () => {
  const rows = new Map<string, Record<string, unknown>>();
  const target = {
    delete(modelName: string, id: string): void {
      rows.delete(`${modelName}:${id}`);
    },
    get(modelName: string, id: string): Record<string, unknown> | null {
      return rows.get(`${modelName}:${id}`) ?? null;
    },
    patch(): void {
      assert.fail("patch should not be called for unknown models");
    },
    put(): void {
      assert.fail("put should not be called for unknown models");
    },
  };
  const registry = {
    hasModel(): boolean {
      return false;
    },
  };

  const result = await applyDeltas(
    {
      actions: [
        {
          action: "U",
          data: { title: "Ignored" },
          id: "42",
          modelId: "task-unknown",
          modelName: "UnknownTask",
        },
      ],
      lastSyncId: "42",
    },
    target,
    registry
  );

  assert.equal(result.lastSyncId, "42");
  assert.equal(result.skipped, 1);
  assert.equal(rows.size, 0);
});

test("applyDeltas skips missing updates instead of creating partial records", async () => {
  const rows = new Map<string, Record<string, unknown>>();
  const target = {
    delete(modelName: string, id: string): void {
      rows.delete(`${modelName}:${id}`);
    },
    get(modelName: string, id: string): Record<string, unknown> | null {
      return rows.get(`${modelName}:${id}`) ?? null;
    },
    patch(
      modelName: string,
      id: string,
      changes: Record<string, unknown>
    ): void {
      const key = `${modelName}:${id}`;
      const existing = rows.get(key);
      if (!existing) {
        return;
      }
      rows.set(key, { ...existing, ...changes });
    },
    put(modelName: string, id: string, data: Record<string, unknown>): void {
      rows.set(`${modelName}:${id}`, { ...data });
    },
  };
  const registry = {
    hasModel(modelName: string): boolean {
      return modelName === "Task";
    },
  };

  const result = await applyDeltas(
    {
      actions: [
        {
          action: "U",
          data: { title: "Partial update" },
          id: "5",
          modelId: "task-missing",
          modelName: "Task",
        },
      ],
      lastSyncId: "5",
    },
    target,
    registry
  );

  assert.equal(rows.has("Task:task-missing"), false);
  assert.equal(result.lastSyncId, "5");
  assert.equal(result.skipped, 1);
  assert.equal(result.updates, 0);
});

test("rebase detects remote archive conflicts against local unarchive", () => {
  const result = rebaseTransactions(
    [
      createUnarchiveTransaction("client-1", "Task", "task-1", {
        original: { archivedAt: 123 },
      }),
    ],
    [
      {
        action: "A",
        clientId: "server-client",
        data: { archivedAt: 456 },
        id: "10",
        modelId: "task-1",
        modelName: "Task",
      },
    ],
    {
      clientId: "client-1",
      defaultResolution: "server-wins",
      fieldLevelConflicts: true,
    }
  );

  assert.equal(result.pending.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]?.conflictType, "update-update");
  assert.equal(result.conflicts[0]?.resolution, "server-wins");
});
