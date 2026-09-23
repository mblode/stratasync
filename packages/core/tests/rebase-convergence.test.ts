/* oxlint-disable no-import-node-test -- uses Node test runner */
import assert from "node:assert/strict";

import type { RebaseOptions, SyncAction, Transaction } from "../src/index";
import {
  createArchiveTransaction,
  createUndoTransaction,
  createUnarchiveTransaction,
  createUpdateTransaction,
  rebaseOriginals,
  rebaseTransactions,
  resolveConflictEffect,
} from "../src/index";

// Counterexamples extracted from verification/lean/StrataSync/Rebase.lean.

const foreignUpdate = (
  id: string,
  data: Record<string, unknown>
): SyncAction => ({
  action: "U",
  clientId: "other-client",
  data,
  id,
  modelId: "task-1",
  modelName: "Task",
});

const clientWins: RebaseOptions = {
  clientId: "client-1",
  defaultResolution: "client-wins",
  fieldLevelConflicts: true,
};

/**
 * Mirrors the delta pipeline: resolve conflicts (patching `original` in place),
 * then fold the whole packet into the originals of the still-pending txs.
 */
const rebasePacket = (pending: Transaction[], actions: SyncAction[]): void => {
  const result = rebaseTransactions(pending, actions, clientWins);
  for (const conflict of result.conflicts) {
    const effect = resolveConflictEffect(conflict);
    if (effect.kind === "patch-original") {
      conflict.localTransaction.original = effect.original;
    }
  }
  const byId = new Map(result.pending.map((tx) => [tx.clientTxId, tx]));
  for (const patch of rebaseOriginals(result.pending, actions)) {
    const tx = byId.get(patch.clientTxId);
    if (tx) {
      tx.original = patch.original;
    }
  }
};

/** What `rollbackTransaction` shows for a rejected update. */
const rollBack = (
  optimistic: Record<string, unknown>,
  tx: Transaction
): Record<string, unknown> => ({ ...optimistic, ...tx.original });

test("client-wins rollback does not restore a stale untracked field", () => {
  let server: Record<string, unknown> = { priority: 1, title: "Seed" };
  const tx = createUpdateTransaction(
    "client-1",
    "Task",
    "task-1",
    { title: "Mine" },
    { title: "Seed" }
  );

  const a1 = foreignUpdate("20", { priority: 5, title: "Theirs" });
  server = { ...server, ...a1.data };
  rebasePacket([tx], [a1]);

  const a2 = foreignUpdate("21", { priority: 7 });
  server = { ...server, ...a2.data };
  rebasePacket([tx], [a2]);

  const optimistic = { ...server, ...tx.payload };
  assert.deepEqual(rollBack(optimistic, tx), server);
});

test("client-wins folds every later action of the same packet into original", () => {
  const server: Record<string, unknown> = { priority: 1, title: "Seed" };
  const tx = createUpdateTransaction(
    "client-1",
    "Task",
    "task-1",
    { title: "Mine" },
    { title: "Seed" }
  );

  const actions = [
    foreignUpdate("20", { title: "Theirs-1" }),
    foreignUpdate("21", { title: "Theirs-2" }),
  ];
  for (const action of actions) {
    Object.assign(server, action.data);
  }
  rebasePacket([tx], actions);

  const optimistic = { ...server, ...tx.payload };
  assert.deepEqual(rollBack(optimistic, tx), server);
  assert.deepEqual(tx.original, { title: "Theirs-2" });
});

test("undo of re-archiving an archived row restores the previous timestamp", () => {
  const archiveTx = createArchiveTransaction("client-1", "Task", "task-1", {
    archivedAt: 200,
    original: { archivedAt: 100 },
  });

  const undo = createUndoTransaction(archiveTx);

  assert.equal(undo?.action, "A");
  assert.deepEqual(undo?.payload, { archivedAt: 100 });
});

test("undo of unarchiving a non-archived row leaves it unarchived", () => {
  const unarchiveTx = createUnarchiveTransaction("client-1", "Task", "task-1", {
    original: { archivedAt: null },
  });

  const undo = createUndoTransaction(unarchiveTx);

  assert.equal(undo?.action, "V");
});

test("an own echo after a conflicting foreign action confirms the tx", () => {
  const tx = createUpdateTransaction(
    "client-1",
    "Task",
    "task-1",
    { title: "Mine" },
    { title: "Seed" }
  );

  const result = rebaseTransactions(
    [tx],
    [
      foreignUpdate("20", { title: "Theirs" }),
      {
        action: "U",
        clientId: "client-1",
        clientTxId: tx.clientTxId,
        data: { title: "Mine" },
        id: "21",
        modelId: "task-1",
        modelName: "Task",
      },
    ],
    { clientId: "client-1", fieldLevelConflicts: true }
  );

  assert.deepEqual(result.confirmed, [tx]);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.pending, []);
});
