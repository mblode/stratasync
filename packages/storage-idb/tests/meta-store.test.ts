/* oxlint-disable no-import-node-test -- uses Node test runner */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { openDB } from "idb";

import {
  addGroup,
  areModelsPersisted,
  DEFAULT_META,
  getMetadata,
  getModelPersistence,
  mergeMetadata,
  META_STORE,
  removeGroup,
  SYNC_META_KEY,
  setMetadata,
  setModelPersistence,
  setModelsPersisted,
  updateMetadata,
} from "../src/stores/meta";
import { deleteDatabases } from "./test-utils";

test("metadata defaults and sync id helpers", async () => {
  const dbName = `meta-${randomUUID()}`;
  const db = await openDB(dbName, 1, {
    upgrade(database) {
      database.createObjectStore(META_STORE);
    },
  });

  const baseline = await getMetadata(db);
  assert.equal(baseline.lastSyncId, DEFAULT_META.lastSyncId);
  assert.deepEqual(baseline.subscribedSyncGroups, []);

  await setMetadata(db, { ...DEFAULT_META, lastSyncId: "12" });
  const meta1 = await getMetadata(db);
  assert.equal(meta1.lastSyncId, "12");

  await updateMetadata(db, { firstSyncId: "4" });
  const meta2 = await getMetadata(db);
  assert.equal(meta2.firstSyncId, "4");

  await updateMetadata(db, { lastSyncAt: Date.now(), lastSyncId: "20" });
  const meta3 = await getMetadata(db);
  assert.equal(meta3.lastSyncId, "20");

  db.close();
  await deleteDatabases([dbName]);
});

test("group helpers track subscribed sync groups", async () => {
  const dbName = `groups-${randomUUID()}`;
  const db = await openDB(dbName, 1, {
    upgrade(database) {
      database.createObjectStore(META_STORE);
    },
  });

  await updateMetadata(db, { subscribedSyncGroups: ["team-1"] });
  const meta1 = await getMetadata(db);
  assert.deepEqual(meta1.subscribedSyncGroups, ["team-1"]);

  await addGroup(db, "team-2");
  const metaBeforeDuplicateAdd = await getMetadata(db);
  const firstUpdatedAt = metaBeforeDuplicateAdd.updatedAt;
  await addGroup(db, "team-2");
  const meta2 = await getMetadata(db);
  assert.deepEqual(meta2.subscribedSyncGroups, ["team-1", "team-2"]);
  assert.equal(meta2.updatedAt, firstUpdatedAt);

  await removeGroup(db, "team-1");
  const meta3 = await getMetadata(db);
  assert.deepEqual(meta3.subscribedSyncGroups, ["team-2"]);

  db.close();
  await deleteDatabases([dbName]);
});

test("mergeMetadata preserves explicit updatedAt values", async () => {
  const dbName = `meta-explicit-${randomUUID()}`;
  const db = await openDB(dbName, 1, {
    upgrade(database) {
      database.createObjectStore(META_STORE);
    },
  });

  await setMetadata(db, { ...DEFAULT_META, updatedAt: 1234 });
  await mergeMetadata(db, { lastSyncId: "12" });

  const meta = await getMetadata(db);
  assert.equal(meta.updatedAt, 1234);
  assert.equal(meta.lastSyncId, "12");

  db.close();
  await deleteDatabases([dbName]);
});

test("model persistence helpers reflect bootstrapping", async () => {
  const dbName = `persist-${randomUUID()}`;
  const db = await openDB(dbName, 1, {
    upgrade(database) {
      database.createObjectStore(META_STORE);
    },
  });

  const initial = await getModelPersistence(db, "Task");
  assert.equal(initial.persisted, false);

  await setModelPersistence(db, "Task", true);
  const updated = await getModelPersistence(db, "Task");
  assert.equal(updated.persisted, true);

  await setModelsPersisted(db, ["Task", "Comment"], true);
  assert.equal(await areModelsPersisted(db, ["Task", "Comment"]), true);

  await updateMetadata(db, {
    bootstrapComplete: true,
    lastSyncAt: Date.now(),
  });
  const meta = await getMetadata(db);
  assert.equal(meta.bootstrapComplete, true);

  const stored = (await db.get(META_STORE, SYNC_META_KEY)) as {
    bootstrapComplete?: boolean;
  };
  assert.equal(stored.bootstrapComplete, true);

  db.close();
  await deleteDatabases([dbName]);
});
