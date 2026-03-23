/* eslint-disable promise/prefer-await-to-callbacks -- test double matches SyncDb.transaction signature */
import { pgTable, text } from "drizzle-orm/pg-core";

import { SyncDao } from "../../src/dao/sync-dao.js";
import type { SyncDb } from "../../src/db.js";

const syncActions = pgTable("sync_actions", {
  action: text("action"),
  clientId: text("client_id"),
  clientTxId: text("client_tx_id"),
  createdAt: text("created_at"),
  data: text("data"),
  groupId: text("group_id"),
  id: text("id").primaryKey(),
  model: text("model"),
  modelId: text("model_id"),
});

const syncGroupMemberships = pgTable("sync_group_memberships", {
  groupId: text("group_id"),
  id: text("id").primaryKey(),
  userId: text("user_id"),
});

const createSelectDb = (
  rowsByTable: Record<string, Record<string, unknown>[]>
) => {
  const db = {} as SyncDb;
  const getTableName = (table: unknown): string => {
    if (table === syncActions) {
      return "sync_actions";
    }
    if (table === syncGroupMemberships) {
      return "sync_group_memberships";
    }
    return "unknown";
  };

  Object.assign(db, {
    delete() {
      throw new Error("delete is not used in these tests");
    },
    insert() {
      throw new Error("insert is not used in these tests");
    },
    select() {
      return {
        from(table) {
          const rows = rowsByTable[getTableName(table)] ?? [];
          return {
            where() {
              return {
                limit() {
                  return Promise.resolve(rows);
                },
                orderBy() {
                  return {
                    limit() {
                      return Promise.resolve(rows);
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    transaction(callback) {
      return callback(db);
    },
    update() {
      throw new Error("update is not used in these tests");
    },
  });

  return db;
};

describe("SyncDao suite", () => {
  it("returns the earliest sync id and supports swapping dbs", async () => {
    const baseDb = createSelectDb({
      sync_actions: [],
    });
    const txDb = createSelectDb({
      sync_actions: [{ id: 9n }],
    });

    const dao = new SyncDao(baseDb, { syncActions, syncGroupMemberships });
    const swapped = dao.withDb(txDb);

    await expect(dao.getEarliestSyncId()).resolves.toBe(0n);
    await expect(swapped.getEarliestSyncId()).resolves.toBe(9n);
  });

  it("returns the first sync id when rows exist", async () => {
    const db = createSelectDb({
      sync_actions: [{ id: 3n }, { id: 9n }],
    });

    const dao = new SyncDao(db, { syncActions, syncGroupMemberships });

    await expect(dao.getEarliestSyncId()).resolves.toBe(3n);
  });
});
