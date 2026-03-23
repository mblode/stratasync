/* oxlint-disable no-import-node-test -- uses Node test runner */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeModelStoreName,
  computePartialDatabaseName,
  computeWorkspaceDatabaseName,
} from "../src/store-names";

const baseRegistry = {
  getModelMetadata: (modelName: string) => ({
    loadStrategy: "instant",
    name: modelName,
  }),
  getPrimaryKey: () => "id",
  getPropertyNames: () => ["title", "status"],
};

test("computeModelStoreName is stable for identical inputs", () => {
  const first = computeModelStoreName("Task", 1, baseRegistry);
  const second = computeModelStoreName("Task", 1, baseRegistry);
  assert.equal(first, second);
});

test("computeModelStoreName ignores property order but tracks changes", () => {
  const ordered = {
    ...baseRegistry,
    getPropertyNames: () => ["a", "b"],
  };
  const reversed = {
    ...baseRegistry,
    getPropertyNames: () => ["b", "a"],
  };
  const withExtra = {
    ...baseRegistry,
    getPropertyNames: () => ["a", "b", "c"],
  };

  const orderedHash = computeModelStoreName("Task", 1, ordered);
  const reversedHash = computeModelStoreName("Task", 1, reversed);
  const extraHash = computeModelStoreName("Task", 1, withExtra);

  assert.equal(orderedHash, reversedHash);
  assert.notEqual(orderedHash, extraHash);
});

test("computeModelStoreName reacts to schemaVersion and loadStrategy", () => {
  const instant = computeModelStoreName("Task", 1, baseRegistry);
  const versioned = computeModelStoreName("Task", 2, baseRegistry);

  const partialRegistry = {
    ...baseRegistry,
    getModelMetadata: (modelName: string) => ({
      loadStrategy: "partial",
      name: modelName,
      partialLoadMode: "regular",
    }),
  };

  const partial = computeModelStoreName("Task", 1, partialRegistry);

  assert.notEqual(instant, versioned);
  assert.notEqual(instant, partial);
});

test("computeModelStoreName changes when primary key changes", () => {
  const idPrimary = computeModelStoreName("Task", 1, baseRegistry);
  const uuidPrimary = computeModelStoreName("Task", 1, {
    ...baseRegistry,
    getPrimaryKey: () => "uuid",
  });

  assert.notEqual(idPrimary, uuidPrimary);
});

test("computeWorkspaceDatabaseName varies with user and versions", () => {
  const base = computeWorkspaceDatabaseName({
    userId: "user",
    userVersion: 1,
    version: 1,
  });
  const differentUser = computeWorkspaceDatabaseName({
    userId: "user-2",
    userVersion: 1,
    version: 1,
  });
  const differentUserVersion = computeWorkspaceDatabaseName({
    userId: "user",
    userVersion: 2,
    version: 1,
  });

  assert.ok(base.startsWith("ss_"));
  assert.notEqual(base, differentUser);
  assert.notEqual(base, differentUserVersion);
});

test("computePartialDatabaseName appends suffix", () => {
  assert.equal(
    computePartialDatabaseName({
      storeName: "abc123",
      workspaceDatabaseName: "workspace-1",
    }),
    "workspace-1_abc123_partial"
  );
});
