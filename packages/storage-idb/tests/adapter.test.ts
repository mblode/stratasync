/* oxlint-disable no-import-node-test -- uses Node test runner */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { ModelRegistry } from "@stratasync/core";
import type { SchemaDefinition } from "@stratasync/core";
import { openDB } from "idb";

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
import { META_STORE } from "../src/stores/meta";
import { SYNC_ACTION_STORE, TRANSACTION_STORE } from "../src/stores/outbox";
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

const computePartialDbName = (
  dbName: string,
  schema: SchemaDefinition,
  schemaVersion: number,
  modelName: string
): string => {
  const registry = new ModelRegistry(schema);
  const storeName = computeModelStoreName(modelName, schemaVersion, registry);
  return computePartialDatabaseName({
    storeName,
    workspaceDatabaseName: dbName,
  });
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
  assert.equal(meta.clientId, undefined);
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

  await deleteDatabases([
    "stratasync_databases",
    dbName,
    computePartialDbName(dbName, baseSchema, 1, "Comment"),
  ]);
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
    computePartialDatabaseName({
      storeName: storeNameV1,
      workspaceDatabaseName: dbName,
    }),
    computePartialDatabaseName({
      storeName: storeNameV2,
      workspaceDatabaseName: dbName,
    }),
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
    computePartialDatabaseName({
      storeName,
      workspaceDatabaseName: dbName,
    }),
  ]);
});

test("partial indexes are isolated per workspace database", async () => {
  const schema: SchemaDefinition = {
    models: {
      Comment: {
        fields: {
          id: {},
          taskId: { indexed: true },
        },
        loadStrategy: "partial",
        name: "Comment",
      },
    },
  };
  const userA = `user-a-${randomUUID()}`;
  const userB = `user-b-${randomUUID()}`;
  const dbNameA = computeWorkspaceDatabaseName({
    userId: userA,
    userVersion: 1,
    version: 1,
  });
  const dbNameB = computeWorkspaceDatabaseName({
    userId: userB,
    userVersion: 1,
    version: 1,
  });

  const adapterA = new IndexedDbStorageAdapter();
  const adapterB = new IndexedDbStorageAdapter();

  await adapterA.open({ schema, userId: userA, userVersion: 1, version: 1 });
  await adapterB.open({ schema, userId: userB, userVersion: 1, version: 1 });

  await adapterA.setPartialIndex("Comment", "taskId", "task-1");

  assert.equal(
    await adapterA.hasPartialIndex("Comment", "taskId", "task-1"),
    true
  );
  assert.equal(
    await adapterB.hasPartialIndex("Comment", "taskId", "task-1"),
    false
  );

  await adapterA.close();
  await adapterB.close();

  await deleteDatabases([
    "stratasync_databases",
    dbNameA,
    dbNameB,
    computePartialDbName(dbNameA, schema, 1, "Comment"),
    computePartialDbName(dbNameB, schema, 1, "Comment"),
  ]);
});

test("concurrent partial DB opens reuse the same connection", async () => {
  const userId = `user-${randomUUID()}`;
  const version = 1;
  const userVersion = 1;
  const dbName = computeWorkspaceDatabaseName({ userId, userVersion, version });

  const adapter = new IndexedDbStorageAdapter();
  await adapter.open({ schema: baseSchema, userId, userVersion, version });

  const internal = adapter as unknown as {
    getPartialDb(modelName: string): Promise<object>;
    partialDbs: Map<string, object>;
    partialDbPromises: Map<string, Promise<object>>;
  };

  const [first, second] = await Promise.all([
    internal.getPartialDb("Comment"),
    internal.getPartialDb("Comment"),
  ]);

  assert.equal(first, second);
  assert.equal(internal.partialDbs.size, 1);
  assert.equal(internal.partialDbPromises.size, 0);

  await adapter.close();
  await deleteDatabases([
    "stratasync_databases",
    dbName,
    computePartialDbName(dbName, baseSchema, 1, "Comment"),
  ]);
});

test("indexed relations create foreign key indexes", async () => {
  const schema: SchemaDefinition = {
    models: {
      Comment: {
        fields: {
          id: {},
        },
        loadStrategy: "partial",
        name: "Comment",
        relations: {
          task: {
            foreignKey: "taskId",
            indexed: true,
            kind: "belongsTo",
            model: "Task",
          },
        },
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
  const userId = `user-${randomUUID()}`;
  const dbName = computeWorkspaceDatabaseName({
    userId,
    userVersion: 1,
    version: 1,
  });

  const adapter = new IndexedDbStorageAdapter();
  await adapter.open({ schema, userId, userVersion: 1, version: 1 });
  await adapter.put("Comment", { id: "comment-1", taskId: "task-1" });

  assert.deepEqual(await adapter.getByIndex("Comment", "taskId", "task-1"), [
    { id: "comment-1", taskId: "task-1" },
  ]);

  await adapter.close();

  await deleteDatabases([
    "stratasync_databases",
    dbName,
    computePartialDbName(dbName, schema, 1, "Comment"),
  ]);
});

test("writeBatch no-ops for empty batches", async () => {
  const userId = `user-${randomUUID()}`;
  const dbName = computeWorkspaceDatabaseName({
    userId,
    userVersion: 1,
    version: 1,
  });
  const adapter = new IndexedDbStorageAdapter();

  await adapter.open({
    schema: baseSchema,
    userId,
    userVersion: 1,
    version: 1,
  });
  await adapter.put("Task", { id: "task-1", title: "Existing" });

  await adapter.writeBatch([]);

  assert.deepEqual(await adapter.get("Task", "task-1"), {
    id: "task-1",
    title: "Existing",
  });

  await adapter.close();
  await deleteDatabases([
    "stratasync_databases",
    dbName,
    computePartialDbName(dbName, baseSchema, 1, "Comment"),
  ]);
});

test("adding a groupKey repairs the store layout on reopen", async () => {
  const base: SchemaDefinition = {
    models: {
      Task: {
        fields: {
          id: {},
          teamId: {},
          title: {},
        },
        loadStrategy: "instant",
        name: "Task",
      },
    },
  };
  const evolved: SchemaDefinition = {
    models: {
      Task: {
        fields: {
          id: {},
          teamId: {},
          title: {},
        },
        groupKey: "teamId",
        loadStrategy: "instant",
        name: "Task",
      },
    },
  };
  const userId = `user-${randomUUID()}`;
  const dbName = computeWorkspaceDatabaseName({
    userId,
    userVersion: 1,
    version: 1,
  });

  const initial = new IndexedDbStorageAdapter();
  await initial.open({ schema: base, userId, userVersion: 1, version: 1 });
  await initial.close();

  const reopened = new IndexedDbStorageAdapter();
  await reopened.open({
    schema: evolved,
    userId,
    userVersion: 1,
    version: 1,
  });
  await reopened.put("Task", {
    id: "task-1",
    teamId: "team-1",
    title: "Test",
  });

  assert.deepEqual(await reopened.getByIndex("Task", "teamId", "team-1"), [
    { id: "task-1", teamId: "team-1", title: "Test" },
  ]);

  const info = await fetchDatabaseInfo(dbName);
  assert.equal(info?.schemaVersion, 2);

  await reopened.close();
  await deleteDatabases(["stratasync_databases", dbName]);
});

test("adding a composite index repairs the store layout on reopen", async () => {
  const base: SchemaDefinition = {
    models: {
      Task: {
        fields: {
          id: {},
          status: {},
          teamId: {},
          title: {},
        },
        loadStrategy: "instant",
        name: "Task",
      },
    },
  };
  const evolved: SchemaDefinition = {
    models: {
      Task: {
        fields: {
          id: {},
          status: {},
          teamId: {},
          title: {},
        },
        indexes: [
          {
            fields: ["teamId", "status"],
          },
        ],
        loadStrategy: "instant",
        name: "Task",
      },
    },
  };
  const userId = `user-${randomUUID()}`;
  const dbName = computeWorkspaceDatabaseName({
    userId,
    userVersion: 1,
    version: 1,
  });

  const initial = new IndexedDbStorageAdapter();
  await initial.open({ schema: base, userId, userVersion: 1, version: 1 });
  await initial.close();

  const reopened = new IndexedDbStorageAdapter();
  await reopened.open({
    schema: evolved,
    userId,
    userVersion: 1,
    version: 1,
  });
  await reopened.put("Task", {
    id: "task-1",
    status: "open",
    teamId: "team-1",
    title: "Composite index",
  });

  const tasksByCompoundIndex = (await reopened.getByIndex(
    "Task",
    "teamId_status",
    ["team-1", "open"]
  )) as Record<string, unknown>[];

  assert.deepEqual(tasksByCompoundIndex, [
    {
      id: "task-1",
      status: "open",
      teamId: "team-1",
      title: "Composite index",
    },
  ]);

  const info = await fetchDatabaseInfo(dbName);
  assert.equal(info?.schemaVersion, 2);

  await reopened.close();
  await deleteDatabases(["stratasync_databases", dbName]);
});

test("reopen repairs mismatched unique index definitions", async () => {
  const schema: SchemaDefinition = {
    models: {
      Task: {
        fields: {
          id: {},
          status: {},
          teamId: {},
          title: {},
        },
        indexes: [
          {
            fields: ["teamId", "status"],
            unique: true,
          },
        ],
        loadStrategy: "instant",
        name: "Task",
      },
    },
  };
  const userId = `user-${randomUUID()}`;
  const dbName = computeWorkspaceDatabaseName({
    userId,
    userVersion: 1,
    version: 1,
  });
  const registry = new ModelRegistry(schema);
  const storeName = computeModelStoreName("Task", 1, registry);

  await openDB(dbName, 1, {
    upgrade: (db) => {
      db.createObjectStore(META_STORE);
      const txStore = db.createObjectStore(TRANSACTION_STORE, {
        keyPath: "clientTxId",
      });
      txStore.createIndex("byState", "state");
      txStore.createIndex("byCreatedAt", "createdAt");
      txStore.createIndex("byBatchIndex", "batchIndex");
      db.createObjectStore(SYNC_ACTION_STORE, { keyPath: "id" });

      const taskStore = db.createObjectStore(storeName, { keyPath: "id" });
      taskStore.createIndex("teamId_status", ["teamId", "status"], {
        unique: false,
      });
    },
  }).then((db) => db.close());

  const manager = new DatabaseManager();
  await manager.open();
  await manager.saveDatabase({
    name: dbName,
    schemaHash: registry.getSchemaHash(),
    schemaVersion: 1,
    updatedAt: Date.now(),
    userId,
    userVersion: 1,
    version: 1,
  });
  manager.close();

  const adapter = new IndexedDbStorageAdapter();
  await adapter.open({ schema, userId, userVersion: 1, version: 1 });
  await adapter.put("Task", {
    id: "task-1",
    status: "open",
    teamId: "team-1",
    title: "Unique composite index",
  });

  await assert.rejects(
    adapter.put("Task", {
      id: "task-2",
      status: "open",
      teamId: "team-1",
      title: "Duplicate composite key",
    })
  );

  const info = await fetchDatabaseInfo(dbName);
  assert.equal(info?.schemaVersion, 2);

  await adapter.close();
  await deleteDatabases(["stratasync_databases", dbName]);
});

test("changing primaryKey with the same field set repairs the store layout", async () => {
  const base: SchemaDefinition = {
    models: {
      Task: {
        fields: {
          id: {},
          slug: {},
          title: {},
        },
        loadStrategy: "instant",
        name: "Task",
        primaryKey: "id",
      },
    },
  };
  const evolved: SchemaDefinition = {
    models: {
      Task: {
        fields: {
          id: {},
          slug: {},
          title: {},
        },
        loadStrategy: "instant",
        name: "Task",
        primaryKey: "slug",
      },
    },
  };
  const userId = `user-${randomUUID()}`;
  const dbName = computeWorkspaceDatabaseName({
    userId,
    userVersion: 1,
    version: 1,
  });

  const initial = new IndexedDbStorageAdapter();
  await initial.open({ schema: base, userId, userVersion: 1, version: 1 });
  await initial.close();

  const reopened = new IndexedDbStorageAdapter();
  await reopened.open({
    schema: evolved,
    userId,
    userVersion: 1,
    version: 1,
  });
  await reopened.put("Task", {
    slug: "task-1",
    title: "Primary key changed",
  });

  assert.deepEqual(await reopened.get("Task", "task-1"), {
    slug: "task-1",
    title: "Primary key changed",
  });

  const info = await fetchDatabaseInfo(dbName);
  assert.equal(info?.schemaVersion, 2);

  await reopened.close();
  await deleteDatabases(["stratasync_databases", dbName]);
});

test("blocked adapters clear their closed workspace handle", async () => {
  const userId = `user-${randomUUID()}`;
  const version = 1;
  const userVersion = 1;
  const dbName = computeWorkspaceDatabaseName({ userId, userVersion, version });

  const adapterV1 = new IndexedDbStorageAdapter();
  await adapterV1.open({ schema: baseSchema, userId, userVersion, version });

  const adapterV2 = new IndexedDbStorageAdapter();
  await adapterV2.open({ schema: evolvedSchema, userId, userVersion, version });

  assert.throws(
    () => adapterV1.getAll("Task"),
    /Database not open\. Call open\(\) first\./
  );

  await adapterV1.close();
  await adapterV2.close();

  await deleteDatabases([
    "stratasync_databases",
    dbName,
    computePartialDbName(dbName, baseSchema, 1, "Comment"),
    computePartialDbName(dbName, evolvedSchema, 2, "Comment"),
  ]);
});
