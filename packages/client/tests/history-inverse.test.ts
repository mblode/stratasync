import { HistoryManager } from "../src/history-manager";

// Counterexamples extracted from verification/lean/StrataSync/Rebase.lean:
// undo must restore the archive state that preceded the change.
describe("HistoryManager archive undo inverse law", () => {
  it("undoing a re-archive of an archived row restores the previous timestamp", () => {
    const history = new HistoryManager();

    const entry = history.buildEntry(
      "A",
      "Task",
      "task-1",
      { archivedAt: 200 },
      { archivedAt: 100 }
    );

    expect(entry?.undo).toEqual({
      action: "A",
      modelId: "task-1",
      modelName: "Task",
      original: { archivedAt: 200 },
      payload: { archivedAt: 100 },
    });
  });

  it("undoing an unarchive of a non-archived row does not archive it", () => {
    const history = new HistoryManager();

    const entry = history.buildEntry(
      "V",
      "Task",
      "task-1",
      {},
      { archivedAt: null }
    );

    expect(entry?.undo).toEqual({
      action: "V",
      modelId: "task-1",
      modelName: "Task",
      original: { archivedAt: null },
      payload: {},
    });
  });
});
