/* oxlint-disable no-import-node-test -- uses Node test runner */
import assert from "node:assert/strict";

import type { RebaseConflict, SyncAction, Transaction } from "../src/index";
import { rebaseOriginals, resolveConflictEffect } from "../src/index";

const makeTx = (overrides: Partial<Transaction> = {}): Transaction => ({
  action: "U",
  clientId: "client-1",
  clientTxId: "tx-1",
  createdAt: 0,
  modelId: "m1",
  modelName: "Task",
  original: { title: "old" },
  payload: { title: "new" },
  retryCount: 0,
  state: "pending",
  ...overrides,
});

const makeAction = (overrides: Partial<SyncAction> = {}): SyncAction => ({
  action: "U",
  data: {},
  id: "1",
  modelId: "m1",
  modelName: "Task",
  ...overrides,
});

test("rebaseOriginals folds server field changes into tracked fields", () => {
  const tx = makeTx({ original: { title: "old" }, payload: { title: "new" } });
  const action = makeAction({ data: { title: "server" } });

  const patches = rebaseOriginals([tx], [action]);

  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.clientTxId, "tx-1");
  assert.deepEqual(patches[0]?.original, { title: "server" });
  // pure: input transaction is not mutated
  assert.deepEqual(tx.original, { title: "old" });
});

test("rebaseOriginals ignores untracked fields and non-update txs", () => {
  const tx = makeTx({ payload: { title: "new" } });
  const untracked = makeAction({ data: { other: "x" } });
  assert.deepEqual(rebaseOriginals([tx], [untracked]), []);

  const insertTx = makeTx({ action: "I", clientTxId: "tx-2" });
  assert.deepEqual(rebaseOriginals([insertTx], [makeAction()]), []);
});

test("rebaseOriginals only matches same model+id", () => {
  const tx = makeTx();
  const other = makeAction({ data: { title: "server" }, modelId: "m2" });
  assert.deepEqual(rebaseOriginals([tx], [other]), []);
});

test("resolveConflictEffect: server-wins -> drop-local", () => {
  const conflict: RebaseConflict = {
    conflictType: "update-update",
    localTransaction: makeTx(),
    resolution: "server-wins",
    serverAction: makeAction({ data: { title: "server" } }),
  };
  assert.deepEqual(resolveConflictEffect(conflict), { kind: "drop-local" });
});

test("resolveConflictEffect: manual coerced to drop-local", () => {
  const conflict: RebaseConflict = {
    conflictType: "insert-insert",
    localTransaction: makeTx(),
    resolution: "manual",
    serverAction: makeAction(),
  };
  assert.deepEqual(resolveConflictEffect(conflict), { kind: "drop-local" });
});

test("resolveConflictEffect: client-wins on update merges server data", () => {
  const conflict: RebaseConflict = {
    conflictType: "update-update",
    localTransaction: makeTx({ original: { body: "b", title: "old" } }),
    resolution: "client-wins",
    serverAction: makeAction({ data: { title: "server" } }),
  };
  assert.deepEqual(resolveConflictEffect(conflict), {
    kind: "patch-original",
    original: { body: "b", title: "server" },
  });
});

test("resolveConflictEffect: client-wins on non-update -> none", () => {
  const conflict: RebaseConflict = {
    conflictType: "delete-update",
    localTransaction: makeTx({ action: "D" }),
    resolution: "client-wins",
    serverAction: makeAction(),
  };
  assert.deepEqual(resolveConflictEffect(conflict), { kind: "none" });
});
