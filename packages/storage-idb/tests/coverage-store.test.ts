/* oxlint-disable no-import-node-test -- uses Node test runner */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { openDB } from "idb";

import {
  clearPartialIndexes,
  createPartialIndexKey,
  getAllPartialIndexes,
  getPartialIndex,
  hasPartialIndex,
  PARTIAL_INDEX_STORE,
  parsePartialIndexKey,
  setPartialIndex,
} from "../src/stores/coverage";
import { deleteDatabases } from "./test-utils";

test("partial index keys round trip even with colons", () => {
  const key = createPartialIndexKey("taskId", "abc:def");
  const parsed = parsePartialIndexKey(key);
  assert.equal(parsed.indexedKey, "taskId");
  assert.equal(parsed.keyValue, "abc:def");
});

test("partial index store tracks coverage", async () => {
  const dbName = `partial-${randomUUID()}`;
  const db = await openDB(dbName, 1, {
    upgrade(database) {
      database.createObjectStore(PARTIAL_INDEX_STORE);
    },
  });

  const entry = {
    indexedKey: "taskId",
    keyValue: "task-1",
    modelName: "Comment",
  };

  await setPartialIndex(db, entry);
  const stored = await getPartialIndex(db, "taskId", "task-1");
  assert.ok(stored);
  assert.equal(stored?.modelName, "Comment");

  assert.equal(await hasPartialIndex(db, "taskId", "task-1"), true);
  // oxlint-disable-next-line no-await-expression-member
  assert.equal((await getAllPartialIndexes(db)).length, 1);

  // oxlint-disable-next-line no-await-expression-member
  await clearPartialIndexes(db);
  // oxlint-disable-next-line no-await-expression-member
  assert.equal((await getAllPartialIndexes(db)).length, 0);

  db.close();
  await deleteDatabases([dbName]);
});
