import type { HistoryEntry, HistoryOperation } from "../src/history-manager";
import { HistoryManager } from "../src/history-manager";

const buildEntry = (modelId: string): HistoryEntry => {
  const base: Omit<HistoryOperation, "modelId"> = {
    action: "U",
    modelName: "Task",
    original: { title: `${modelId}-before` },
    payload: { title: `${modelId}-after` },
  };

  return {
    redo: {
      ...base,
      modelId,
    },
    undo: {
      ...base,
      modelId,
      original: base.payload,
      payload: base.original ?? {},
    },
  };
};

describe("HistoryManager archive flow", () => {
  it("builds archive undo entries from the archived payload", () => {
    const history = new HistoryManager();

    const entry = history.buildEntry(
      "A",
      "Task",
      "task-1",
      { archivedAt: 123 },
      { archivedAt: undefined }
    );

    expect(entry?.undo).toEqual({
      action: "V",
      modelId: "task-1",
      modelName: "Task",
      original: { archivedAt: 123 },
      payload: {},
    });
  });

  it("builds unarchive undo entries from the original archive state", () => {
    const history = new HistoryManager();

    const entry = history.buildEntry(
      "V",
      "Task",
      "task-1",
      {},
      { archivedAt: 456 }
    );

    expect(entry?.undo).toEqual({
      action: "A",
      modelId: "task-1",
      modelName: "Task",
      original: { archivedAt: null },
      payload: { archivedAt: 456 },
    });
  });

  it("falls back to Date.now when a redo archive has no prior timestamp", () => {
    const history = new HistoryManager();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(789);

    const entry = history.buildEntry("V", "Task", "task-1", {}, {});

    expect(entry?.undo).toEqual({
      action: "A",
      modelId: "task-1",
      modelName: "Task",
      original: { archivedAt: null },
      payload: { archivedAt: 789 },
    });

    nowSpy.mockRestore();
  });

  it("undos grouped entries in reverse order and redoes them in forward order", async () => {
    const history = new HistoryManager();
    const first = buildEntry("task-1");
    const second = buildEntry("task-2");
    const applyOp = vi.fn(async (_operation: HistoryOperation) => {
      /* noop */
    });

    await history.runAsGroup(() => {
      history.record(first, "tx-1");
      history.record(second, "tx-2");
    });

    expect(history.canUndo()).toBeTruthy();
    expect(history.canRedo()).toBeFalsy();

    await history.undo(applyOp);

    expect(applyOp.mock.calls.map(([operation]) => operation.modelId)).toEqual([
      "task-2",
      "task-1",
    ]);
    expect(history.canUndo()).toBeFalsy();
    expect(history.canRedo()).toBeTruthy();

    applyOp.mockClear();

    await history.redo(applyOp);

    expect(applyOp.mock.calls.map(([operation]) => operation.modelId)).toEqual([
      "task-1",
      "task-2",
    ]);
    expect(history.canUndo()).toBeTruthy();
    expect(history.canRedo()).toBeFalsy();
  });

  it("collapses nested groups into one undo step", async () => {
    const history = new HistoryManager();
    const applyOp = vi.fn(async (_operation: HistoryOperation) => {
      /* noop */
    });

    await history.runAsGroup(async () => {
      history.record(buildEntry("outer"), "tx-outer");
      await history.runAsGroup(() => {
        history.record(buildEntry("inner"), "tx-inner");
      });
    });

    await history.undo(applyOp);

    expect(applyOp.mock.calls.map(([operation]) => operation.modelId)).toEqual([
      "inner",
      "outer",
    ]);
    expect(history.canUndo()).toBeFalsy();
    expect(history.canRedo()).toBeTruthy();
  });

  it("rolls back partial undo groups when an operation fails", async () => {
    const history = new HistoryManager();

    await history.runAsGroup(() => {
      history.record(buildEntry("task-1"), "tx-1");
      history.record(buildEntry("task-2"), "tx-2");
    });

    const applied: string[] = [];
    const applyOp = vi.fn((operation: HistoryOperation) => {
      applied.push(`${operation.modelId}:${operation.payload.title as string}`);
      if (
        operation.modelId === "task-1" &&
        operation.payload.title === "task-1-before"
      ) {
        return Promise.reject(new Error("undo failed"));
      }
      return Promise.resolve();
    });

    await expect(history.undo(applyOp)).rejects.toThrow("undo failed");

    expect(applied).toEqual([
      "task-2:task-2-before",
      "task-1:task-1-before",
      "task-2:task-2-after",
    ]);
    expect(history.canUndo()).toBeTruthy();
    expect(history.canRedo()).toBeFalsy();
  });

  it("rolls back partial redo groups when an operation fails", async () => {
    const history = new HistoryManager();

    await history.runAsGroup(() => {
      history.record(buildEntry("task-1"), "tx-1");
      history.record(buildEntry("task-2"), "tx-2");
    });

    const noop = vi.fn(async (_operation: HistoryOperation) => {
      /* noop */
    });
    await history.undo(noop);

    const applied: string[] = [];
    const applyOp = vi.fn((operation: HistoryOperation) => {
      applied.push(`${operation.modelId}:${operation.payload.title as string}`);
      if (
        operation.modelId === "task-2" &&
        operation.payload.title === "task-2-after"
      ) {
        return Promise.reject(new Error("redo failed"));
      }
      return Promise.resolve();
    });

    await expect(history.redo(applyOp)).rejects.toThrow("redo failed");

    expect(applied).toEqual([
      "task-1:task-1-after",
      "task-2:task-2-after",
      "task-1:task-1-before",
    ]);
    expect(history.canUndo()).toBeFalsy();
    expect(history.canRedo()).toBeTruthy();
  });

  it("invalidates a committed group when any grouped transaction is removed", async () => {
    const history = new HistoryManager();

    await history.runAsGroup(() => {
      history.record(buildEntry("task-1"), "tx-1");
      history.record(buildEntry("task-2"), "tx-2");
    });

    expect(history.canUndo()).toBeTruthy();

    history.removeByTxId("tx-1");

    expect(history.canUndo()).toBeFalsy();
    expect(history.canRedo()).toBeFalsy();
  });

  it("invalidates an active group when any grouped transaction is removed before commit", async () => {
    const history = new HistoryManager();

    await history.runAsGroup(() => {
      history.record(buildEntry("task-1"), "tx-1");
      history.removeByTxId("tx-1");
      history.record(buildEntry("task-2"), "tx-2");
    });

    expect(history.canUndo()).toBeFalsy();
    expect(history.canRedo()).toBeFalsy();
  });
});
