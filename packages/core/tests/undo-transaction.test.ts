/* oxlint-disable no-import-node-test -- uses Node test runner */
import assert from "node:assert/strict";

import {
  createUndoTransaction,
  createUpdateTransaction,
  replaceUndefinedWithNull,
} from "../src/index";

test("replaceUndefinedWithNull maps only undefined members to null", () => {
  assert.deepEqual(
    replaceUndefinedWithNull({
      a: undefined,
      b: null,
      c: 0,
      d: "",
      e: false,
    }),
    { a: null, b: null, c: 0, d: "", e: false }
  );
});

test("undoing an update sends an explicit null for fields that had no value", () => {
  // The field was absent before the change: `original` records `undefined`.
  const updateTx = createUpdateTransaction(
    "client-1",
    "Task",
    "task-1",
    { dueDate: "2026-01-01", title: "Renamed" },
    { dueDate: undefined, title: "Seed" }
  );

  const undo = createUndoTransaction(updateTx);

  assert.equal(undo?.action, "U");
  // JSON would drop `dueDate: undefined`, leaving the server value in place.
  assert.deepEqual(undo?.payload, { dueDate: null, title: "Seed" });
  // JSON, not structuredClone: dropping `undefined` members is exactly the
  // wire behaviour under test, and structuredClone preserves them.
  // oxlint-disable-next-line prefer-structured-clone
  assert.deepEqual(JSON.parse(JSON.stringify(undo?.payload)), {
    dueDate: null,
    title: "Seed",
  });
  assert.deepEqual(undo?.original, {
    dueDate: "2026-01-01",
    title: "Renamed",
  });
});
