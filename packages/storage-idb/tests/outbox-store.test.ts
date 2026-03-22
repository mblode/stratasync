/* oxlint-disable no-import-node-test -- uses Node test runner */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import type { Transaction } from "@stratasync/core";
import { openDB } from "idb";

import {
  addTransaction,
  clearOutbox,
  getPendingCount,
  getTransaction,
  getTransactionsByState,
  MAX_RETRY_COUNT,
  markTransactionFailed,
  requeueTransaction,
  resetSentToQueued,
  TRANSACTION_STORE,
  updateTransaction,
} from "../src/stores/outbox";
import { deleteDatabases } from "./test-utils";

test("outbox state transitions follow Done semantics", async () => {
  const dbName = `outbox-${randomUUID()}`;
  const db = await openDB(dbName, 1, {
    upgrade(database) {
      const store = database.createObjectStore(TRANSACTION_STORE, {
        keyPath: "clientTxId",
      });
      store.createIndex("byState", "state");
      store.createIndex("byCreatedAt", "createdAt");
      store.createIndex("byBatchIndex", "batchIndex");
    },
  });

  const tx: Transaction = {
    action: "I",
    clientId: "client-1",
    clientTxId: "tx-1",
    createdAt: Date.now(),
    modelId: "task-1",
    modelName: "Task",
    payload: { title: "Test" },
    retryCount: 0,
    state: "queued",
  };

  await addTransaction(db, tx);
  // oxlint-disable-next-line no-await-expression-member
  assert.equal((await getTransactionsByState(db, "queued")).length, 1);
  assert.equal(await getPendingCount(db), 1);

  // oxlint-disable-next-line no-await-expression-member
  await updateTransaction(db, tx.clientTxId, { state: "sent" });
  // oxlint-disable-next-line no-await-expression-member
  assert.equal((await getTransactionsByState(db, "sent")).length, 1);
  assert.equal(await getPendingCount(db), 1);

  // oxlint-disable-next-line no-await-expression-member
  const resetCount = await resetSentToQueued(db);
  // oxlint-disable-next-line no-await-expression-member
  assert.equal(resetCount, 1);
  // oxlint-disable-next-line no-await-expression-member
  assert.equal((await getTransactionsByState(db, "queued")).length, 1);

  await markTransactionFailed(db, tx.clientTxId, "boom");
  const failed = await getTransactionsByState(db, "failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.retryCount, 1);

  await updateTransaction(db, tx.clientTxId, { retryCount: MAX_RETRY_COUNT });
  const requeued = await requeueTransaction(db, tx.clientTxId);
  assert.equal(requeued, false);

  const current = await getTransaction(db, tx.clientTxId);
  assert.ok(current);
  // oxlint-disable-next-line no-await-expression-member
  assert.equal(current?.state, "failed");

  // oxlint-disable-next-line no-await-expression-member
  await clearOutbox(db);
  // oxlint-disable-next-line no-await-expression-member
  assert.equal((await getTransactionsByState(db, "queued")).length, 0);

  db.close();
  await deleteDatabases([dbName]);
});
