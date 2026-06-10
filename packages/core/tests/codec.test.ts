/* oxlint-disable no-import-node-test -- uses Node test runner */
import assert from "node:assert/strict";

import {
  deserializeModelRecord,
  isAlreadySerializedValue,
  serializeModelRecord,
} from "../src/index";
import type { PropertyMetadata } from "../src/schema/types";

const dateSerializer = {
  deserialize: (value: unknown): unknown =>
    typeof value === "string" ? new Date(value) : value,
  serialize: (value: unknown): unknown =>
    value instanceof Date ? value.toISOString() : value,
};

const dateProps = (): Map<string, PropertyMetadata> =>
  new Map<string, PropertyMetadata>([
    ["due", { serializer: dateSerializer, type: "date" } as PropertyMetadata],
  ]);

test("serializeModelRecord serializes via property serializer", () => {
  const out = serializeModelRecord(dateProps(), {
    due: new Date("2024-01-02T03:04:05.000Z"),
    id: "1",
    plain: 7,
  });
  assert.deepEqual(out, {
    due: "2024-01-02T03:04:05.000Z",
    id: "1",
    plain: 7,
  });
});

test("serializeModelRecord leaves already-serialized values untouched", () => {
  const out = serializeModelRecord(dateProps(), {
    due: "2024-01-02T03:04:05.000Z",
  });
  assert.deepEqual(out, { due: "2024-01-02T03:04:05.000Z" });
});

test("serializeModelRecord passes id and undefined through", () => {
  const out = serializeModelRecord(dateProps(), { due: undefined, id: "x" });
  assert.deepEqual(out, { due: undefined, id: "x" });
});

test("deserializeModelRecord hydrates via serializer", () => {
  const out = deserializeModelRecord(dateProps(), {
    due: "2024-01-02T03:04:05.000Z",
  });
  assert.ok((out.due as Date) instanceof Date);
});

test("deserializeModelRecord returns data as-is for empty properties", () => {
  const data = { a: 1 };
  assert.equal(deserializeModelRecord(new Map(), data), data);
});

test("isAlreadySerializedValue detects round-trip identity", () => {
  assert.equal(
    isAlreadySerializedValue(dateSerializer, "2024-01-02T03:04:05.000Z"),
    true
  );
  assert.equal(isAlreadySerializedValue(dateSerializer, new Date()), false);
});
