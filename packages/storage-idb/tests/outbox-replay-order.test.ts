/* oxlint-disable no-import-node-test -- uses Node test runner */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { Transaction } from "@stratasync/core";
import { openDB } from "idb";

import {
  addTransaction,
  getAllTransactions,
  TRANSACTION_STORE,
} from "../src/stores/outbox";
import { deleteDatabases } from "./test-utils";

const openOutbox = (dbName: string) =>
  openDB(dbName, 1, {
    upgrade(database) {
      const store = database.createObjectStore(TRANSACTION_STORE, {
        keyPath: "clientTxId",
      });
      store.createIndex("byState", "state");
      store.createIndex("byCreatedAt", "createdAt");
      store.createIndex("byBatchIndex", "batchIndex");
    },
  });

const makeTx = (
  overrides: Partial<Transaction> & Pick<Transaction, "clientTxId">
): Transaction => ({
  action: "U",
  clientId: "client-1",
  createdAt: 0,
  modelId: "task-1",
  modelName: "Task",
  payload: {},
  retryCount: 0,
  state: "queued",
  ...overrides,
});

test("replays in batchIndex order when the wall clock steps backwards", async () => {
  const dbName = `outbox-clock-${randomUUID()}`;
  const db = await openOutbox(dbName);

  // `create X` is stamped first (batchIndex 0); NTP then steps the clock back
  // a second before `update X` (batchIndex 1) is stamped.
  await addTransaction(
    db,
    makeTx({
      action: "I",
      batchIndex: 0,
      clientTxId: "tx-create",
      createdAt: 10_000,
      payload: { id: "task-1", title: "Created" },
    })
  );
  await addTransaction(
    db,
    makeTx({
      batchIndex: 1,
      clientTxId: "tx-update",
      createdAt: 9000,
      payload: { title: "Renamed" },
    })
  );

  const ordered = await getAllTransactions(db);
  assert.deepEqual(
    ordered.map((tx) => tx.clientTxId),
    ["tx-create", "tx-update"]
  );

  db.close();
  await deleteDatabases([dbName]);
});

test("replays legacy rows without a batchIndex first, by createdAt", async () => {
  const dbName = `outbox-legacy-${randomUUID()}`;
  const db = await openOutbox(dbName);

  // Rows persisted before transactions carried a sequence predate every
  // stamped row, so they replay ahead of them and among themselves by time.
  await addTransaction(
    db,
    makeTx({ batchIndex: 0, clientTxId: "stamped", createdAt: 1 })
  );
  await addTransaction(db, makeTx({ clientTxId: "legacy-b", createdAt: 5 }));
  await addTransaction(db, makeTx({ clientTxId: "legacy-a", createdAt: 3 }));

  const ordered = await getAllTransactions(db);
  assert.deepEqual(
    ordered.map((tx) => tx.clientTxId),
    ["legacy-a", "legacy-b", "stamped"]
  );

  db.close();
  await deleteDatabases([dbName]);
});
