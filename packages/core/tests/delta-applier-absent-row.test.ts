import assert from "node:assert/strict";

import { applyDeltas } from "../src/index";
import type { SyncAction } from "../src/index";

// Counterexample from verification/lean/StrataSync/DeltaPipeline.lean:
// bug_archive_on_absent_row_stages_stub. Deltas apply only to loaded rows; an
// archive/unarchive carries no full row, so it must not invent one.
const createTarget = (seed: [string, Record<string, unknown>][] = []) => {
  const rows = new Map<string, Record<string, unknown>>(seed);
  const target = {
    delete(modelName: string, id: string): Promise<void> {
      rows.delete(`${modelName}:${id}`);
      return Promise.resolve();
    },
    get(
      modelName: string,
      id: string
    ): Promise<Record<string, unknown> | null> {
      return Promise.resolve(rows.get(`${modelName}:${id}`) ?? null);
    },
    patch(
      modelName: string,
      id: string,
      changes: Record<string, unknown>
    ): Promise<void> {
      const key = `${modelName}:${id}`;
      const existing = rows.get(key);
      if (existing) {
        rows.set(key, { ...existing, ...changes });
      }
      return Promise.resolve();
    },
    put(
      modelName: string,
      id: string,
      data: Record<string, unknown>
    ): Promise<void> {
      rows.set(`${modelName}:${id}`, { ...data });
      return Promise.resolve();
    },
  };
  return { rows, target };
};

const registry = { hasModel: (modelName: string) => modelName === "Task" };

const action = (
  kind: "A" | "V",
  id: string,
  data: Record<string, unknown> = {}
): SyncAction => ({
  action: kind,
  data,
  id,
  modelId: "task-absent",
  modelName: "Task",
});

test("archive and unarchive of a row not stored locally write nothing", async () => {
  for (const kind of ["A", "V"] as const) {
    const { rows, target } = createTarget();
    const result = await applyDeltas(
      {
        actions: [action(kind, "5", { archivedAt: 99, title: "Partial" })],
        lastSyncId: "5",
      },
      target,
      registry,
      { mergeUpdates: true }
    );

    assert.equal(rows.has("Task:task-absent"), false, kind);
    assert.equal(result.skipped, 1, kind);
    assert.equal(result.archives + result.unarchives, 0, kind);
    assert.equal(result.lastSyncId, "5", kind);
  }
});

test("archive and unarchive still merge into a stored row", async () => {
  const { rows, target } = createTarget([
    ["Task:task-absent", { id: "task-absent", title: "Stored" }],
  ]);
  const result = await applyDeltas(
    { actions: [action("A", "5", { archivedAt: 99 })], lastSyncId: "5" },
    target,
    registry
  );

  assert.deepEqual(rows.get("Task:task-absent"), {
    archivedAt: 99,
    id: "task-absent",
    title: "Stored",
  });
  assert.equal(result.archives, 1);

  await applyDeltas(
    { actions: [action("V", "6")], lastSyncId: "6" },
    target,
    registry
  );
  assert.deepEqual(rows.get("Task:task-absent"), {
    archivedAt: null,
    id: "task-absent",
    title: "Stored",
  });
});
