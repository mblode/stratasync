/* oxlint-disable no-import-node-test -- uses Node test runner */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { ModelRegistry } from "@stratasync/core";
import type { SchemaDefinition } from "@stratasync/core";

import {
  createIndexedDbStorage,
  IndexedDbStorageAdapter,
} from "../src/adapter";
import { DatabaseManager } from "../src/database-manager";
import {
  computeModelStoreName,
  computePartialDatabaseName,
  computeWorkspaceDatabaseName,
} from "../src/store-names";
import { deleteDatabases } from "./test-utils";

const baseSchema: SchemaDefinition = {
  models: {
    Comment: {
      fields: {
        id: {},
        taskId: { indexed: true },
      },
      loadStrategy: "partial",
      name: "Comment",
    },
    Task: {
      fields: {
        id: {},
        title: {},
      },
      loadStrategy: "instant",
      name: "Task",
    },
  },
};

const evolvedSchema: SchemaDefinition = {
  models: {
    Comment: {
      fields: {
        body: {},
        id: {},
        taskId: { indexed: true },
      },
      loadStrategy: "partial",
      name: "Comment",
    },
    Task: {
      fields: {
        id: {},
        title: {},
        updatedAt: {},
      },
      loadStrategy: "instant",
      name: "Task",
    },
  },
};

const fetchDatabaseInfo = async (
  name: string
): Promise<{ schemaVersion: number } | null> => {
  const manager = new DatabaseManager();
  await manager.open();
  const info = await manager.getDatabaseInfo(name);
  manager.close();
  return info;
};

test("IndexedDbStorageAdapter registers workspace database metadata", async () => {
  const userId = `user-${randomUUID()}`;
  const version = 1;
  const userVersion = 1;
  const dbName = computeWorkspaceDatabaseName({ userId, userVersion, version });

  const adapter = createIndexedDbStorage();
  await adapter.open({ schema: baseSchema, userId, userVersion, version });

  const registry = new ModelRegistry(baseSchema);
  const meta = await adapter.getMeta();
  assert.equal(meta.schemaHash, registry.getSchemaHash());
  assert.deepEqual(meta.subscribedSyncGroups, []);

  const taskPersistence = await adapter.getModelPersistence("Task");
  assert.equal(taskPersistence.persisted, false);

  const info = await fetchDatabaseInfo(dbName);
  assert.ok(info);
  assert.equal(info?.schemaVersion, 1);

  const hasPartial = await adapter.hasPartialIndex(
    "Comment",
    "taskId",
    "task-1"
  );
  assert.equal(hasPartial, false);

  await adapter.setPartialIndex("Comment", "taskId", "task-1");
  assert.equal(
    await adapter.hasPartialIndex("Comment", "taskId", "task-1"),
    true
  );

  await adapter.close();

  const registryV1 = new ModelRegistry(baseSchema);
  const storeName = computeModelStoreName("Comment", 1, registryV1);
  const partialDbName = computePartialDatabaseName(storeName);

  await deleteDatabases(["stratasync_databases", dbName, partialDbName]);
});

test("schema hash changes bump schemaVersion", async () => {
  const userId = `user-${randomUUID()}`;
  const version = 1;
  const userVersion = 1;
  const dbName = computeWorkspaceDatabaseName({ userId, userVersion, version });

  const adapterV1 = new IndexedDbStorageAdapter();
  await adapterV1.open({ schema: baseSchema, userId, userVersion, version });
  await adapterV1.close();

  const adapterV2 = new IndexedDbStorageAdapter();
  await adapterV2.open({ schema: evolvedSchema, userId, userVersion, version });
  await adapterV2.close();

  const info = await fetchDatabaseInfo(dbName);
  assert.ok(info);
  assert.equal(info?.schemaVersion, 2);

  const registryV1 = new ModelRegistry(baseSchema);
  const registryV2 = new ModelRegistry(evolvedSchema);
  const storeNameV1 = computeModelStoreName("Comment", 1, registryV1);
  const storeNameV2 = computeModelStoreName("Comment", 2, registryV2);

  await deleteDatabases([
    "stratasync_databases",
    dbName,
    computePartialDatabaseName(storeNameV1),
    computePartialDatabaseName(storeNameV2),
  ]);
});

test("bootstrapComplete marks instant models persisted on reopen", async () => {
  const userId = `user-${randomUUID()}`;
  const version = 1;
  const userVersion = 1;
  const dbName = computeWorkspaceDatabaseName({ userId, userVersion, version });

  const adapter = new IndexedDbStorageAdapter();
  await adapter.open({ schema: baseSchema, userId, userVersion, version });
  await adapter.setMeta({ bootstrapComplete: true });
  await adapter.close();

  const reopened = new IndexedDbStorageAdapter();
  await reopened.open({ schema: baseSchema, userId, userVersion, version });

  const taskPersistence = await reopened.getModelPersistence("Task");
  const commentPersistence = await reopened.getModelPersistence("Comment");

  assert.equal(taskPersistence.persisted, true);
  assert.equal(commentPersistence.persisted, false);

  await reopened.close();

  const registry = new ModelRegistry(baseSchema);
  const storeName = computeModelStoreName("Comment", 1, registry);

  await deleteDatabases([
    "stratasync_databases",
    dbName,
    computePartialDatabaseName(storeName),
  ]);
});
