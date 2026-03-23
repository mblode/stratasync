import { sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";

import type { SyncModelConfig } from "../../src/config.js";
import { SyncDao } from "../../src/dao/sync-dao.js";
import type { SyncDb } from "../../src/db.js";
import { MutateService } from "../../src/mutate/mutate-service.js";
import type { TransactionInput } from "../../src/types.js";

const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title"),
  workspaceId: text("workspace_id"),
});

const taskLabels = pgTable("task_labels", {
  labelId: text("label_id"),
  taskId: text("task_id"),
});

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

interface RecordedWrite {
  data: Record<string, unknown>;
  table: string;
}

const createDedupError = (): Error =>
  Object.assign(new Error("duplicate sync action"), {
    code: "23505",
    constraint: "sync_actions_client_id_client_tx_id_unique",
  });

const createMutationDb = (options?: { failSyncActionInsert?: boolean }) => {
  const committedWrites: RecordedWrite[] = [];
  const selectRows = new Map<string, Record<string, unknown>[]>();
  let transactionCalls = 0;

  const getTableName = (table: unknown): string => {
    if (table === tasks) {
      return "tasks";
    }
    if (table === syncActions) {
      return "sync_actions";
    }
    if (table === syncGroupMemberships) {
      return "sync_group_memberships";
    }
    return "unknown";
  };

  const makeDb = (writes: RecordedWrite[]): SyncDb => {
    const db: SyncDb = {
      delete() {
        throw new Error("delete is not used in these tests");
      },
      insert(table) {
        const tableName = getTableName(table);
        return {
          values(data: Record<string, unknown>) {
            if (tableName !== "sync_actions") {
              writes.push({
                data,
                table: tableName,
              });
              return Promise.resolve();
            }

            return {
              returning() {
                if (
                  options?.failSyncActionInsert &&
                  tableName === "sync_actions"
                ) {
                  return Promise.reject(createDedupError());
                }

                writes.push({
                  data,
                  table: tableName,
                });

                return Promise.resolve([
                  {
                    action: data.action,
                    clientId: data.clientId,
                    clientTxId: data.clientTxId,
                    createdAt: new Date("2024-06-15T12:00:00.000Z"),
                    data: data.data,
                    groupId: data.groupId,
                    id: 7n,
                    model: data.model,
                    modelId: data.modelId,
                  },
                ]);
              },
            };
          },
        };
      },
      select() {
        return {
          from(table) {
            const tableName = getTableName(table);
            return {
              where() {
                const rows = selectRows.get(tableName) ?? [];
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
      transaction(fn) {
        transactionCalls += 1;
        const transactionWrites: RecordedWrite[] = [];
        const txDb = makeDb(transactionWrites);

        return Promise.resolve(fn(txDb)).then((result) => {
          committedWrites.push(...transactionWrites);
          return result;
        });
      },
      update() {
        throw new Error("update is not used in these tests");
      },
    };

    return db;
  };

  const db = makeDb(committedWrites);
  return {
    committedWrites,
    db,
    selectRows,
    transactionCalls: () => transactionCalls,
  };
};

const createUpdateMutationDb = (
  taskRows: Record<string, unknown>[],
  options?: { affectedRowCount?: number }
) => {
  const committedWrites: RecordedWrite[] = [];
  let transactionCalls = 0;
  const getTableName = (table: unknown): string => {
    if (table === tasks) {
      return "tasks";
    }
    if (table === syncActions) {
      return "sync_actions";
    }
    if (table === syncGroupMemberships) {
      return "sync_group_memberships";
    }
    return "unknown";
  };

  const makeDb = (writes: RecordedWrite[]): SyncDb => ({
    delete() {
      throw new Error("delete is not used in these tests");
    },
    insert(table) {
      const tableName = getTableName(table);
      return {
        values(data: Record<string, unknown>) {
          return {
            returning() {
              writes.push({
                data,
                table: tableName,
              });

              if (tableName === "sync_actions") {
                return Promise.resolve([
                  {
                    action: data.action,
                    clientId: data.clientId,
                    clientTxId: data.clientTxId,
                    createdAt: new Date("2024-06-15T12:00:00.000Z"),
                    data: data.data,
                    groupId: data.groupId,
                    id: 7n,
                    model: data.model,
                    modelId: data.modelId,
                  },
                ]);
              }

              return Promise.resolve([{}]);
            },
          };
        },
      };
    },
    select() {
      return {
        from(table) {
          const tableName = getTableName(table);
          return {
            where() {
              let rows: Record<string, unknown>[];
              if (tableName === "tasks") {
                rows = taskRows;
              } else if (tableName === "sync_actions") {
                rows = [];
              } else {
                rows = [];
              }

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
    transaction(fn) {
      transactionCalls += 1;
      const transactionWrites: RecordedWrite[] = [];
      const txDb = makeDb(transactionWrites);

      return Promise.resolve(fn(txDb)).then((result) => {
        committedWrites.push(...transactionWrites);
        return result;
      });
    },
    update(table) {
      const tableName = getTableName(table);
      return {
        set(data: Record<string, unknown>) {
          return {
            where() {
              writes.push({
                data,
                table: tableName,
              });
              return Promise.resolve({
                rowCount: options?.affectedRowCount ?? taskRows.length,
              });
            },
          };
        },
      };
    },
  });

  const db = makeDb(committedWrites);
  return {
    committedWrites,
    db,
    transactionCalls: () => transactionCalls,
  };
};

const createCompositeDeleteMutationDb = (options?: {
  deleteRowCount?: number;
}) => {
  const committedWrites: RecordedWrite[] = [];
  let transactionCalls = 0;

  const getTableName = (table: unknown): string => {
    if (table === taskLabels) {
      return "task_labels";
    }
    if (table === syncActions) {
      return "sync_actions";
    }
    if (table === syncGroupMemberships) {
      return "sync_group_memberships";
    }
    return "unknown";
  };

  const makeDb = (writes: RecordedWrite[]): SyncDb => ({
    delete(table) {
      const tableName = getTableName(table);
      return {
        where() {
          writes.push({
            data: {},
            table: tableName,
          });
          return Promise.resolve({
            rowCount: options?.deleteRowCount ?? 1,
          });
        },
      };
    },
    insert(table) {
      const tableName = getTableName(table);
      return {
        values(data: Record<string, unknown>) {
          return {
            returning() {
              writes.push({
                data,
                table: tableName,
              });

              return Promise.resolve([
                {
                  action: data.action,
                  clientId: data.clientId,
                  clientTxId: data.clientTxId,
                  createdAt: new Date("2024-06-15T12:00:00.000Z"),
                  data: data.data,
                  groupId: data.groupId,
                  id: 7n,
                  model: data.model,
                  modelId: data.modelId,
                },
              ]);
            },
          };
        },
      };
    },
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  return Promise.resolve([]);
                },
                orderBy() {
                  return {
                    limit() {
                      return Promise.resolve([]);
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    transaction(fn) {
      transactionCalls += 1;
      const transactionWrites: RecordedWrite[] = [];
      const txDb = makeDb(transactionWrites);

      return Promise.resolve(fn(txDb)).then((result) => {
        committedWrites.push(...transactionWrites);
        return result;
      });
    },
    update() {
      throw new Error("update is not used in these tests");
    },
  });

  const db = makeDb(committedWrites);
  return {
    committedWrites,
    db,
    transactionCalls: () => transactionCalls,
  };
};

const createTaskModelConfig = (
  options?: Pick<NonNullable<SyncModelConfig["mutate"]>, "onAfterMutation">
): SyncModelConfig => ({
  bootstrap: {
    buildScopeWhere: () => sql`true`,
    cursor: { idField: "id", type: "simple" },
    fields: ["id", "title", "workspaceId"],
  },
  groupKey: null,
  mutate: {
    actions: new Set(["I"]),
    idField: "id",
    insertFields: {
      title: { type: "string" },
      workspaceId: { type: "string" },
    },
    kind: "standard",
    ...options,
  },
  table: tasks,
});

const createUpdatableTaskModelConfig = (
  groupKey: SyncModelConfig["groupKey"]
): SyncModelConfig => ({
  bootstrap: {
    buildScopeWhere: () => sql`true`,
    cursor: { idField: "id", type: "simple" },
    fields: ["id", "title", "workspaceId"],
  },
  groupKey,
  mutate: {
    actions: new Set(["U"]),
    idField: "id",
    insertFields: {
      title: { type: "string" },
      workspaceId: { type: "string" },
    },
    kind: "standard",
    updateFields: new Set(["title"]),
  },
  table: tasks,
});

const createCompositeDeleteModelConfig = (): SyncModelConfig => ({
  bootstrap: {
    buildScopeWhere: () => sql`true`,
    cursor: {
      fields: ["taskId", "labelId"],
      syntheticId: (item) => `${item.taskId}:${item.labelId}`,
      type: "composite",
    },
    fields: ["taskId", "labelId"],
  },
  groupKey: null,
  mutate: {
    actions: new Set(["D"]),
    buildDeleteWhere: () => sql`true`,
    insertFields: {
      labelId: { type: "string" },
      taskId: { type: "string" },
    },
    kind: "composite",
  },
  table: taskLabels,
});

// ---------------------------------------------------------------------------
// MutateService.validateTransaction
// ---------------------------------------------------------------------------

describe("MutateService.validateTransaction", () => {
  const validTx: TransactionInput = {
    action: "INSERT",
    clientId: "client-1",
    clientTxId: "tx-1",
    modelId: "task-1",
    modelName: "Task",
    payload: { title: "Hello" },
  };

  it("returns empty array for a valid transaction", () => {
    expect(MutateService.validateTransaction(validTx)).toEqual([]);
  });

  it("reports missing clientTxId", () => {
    const errors = MutateService.validateTransaction({
      ...validTx,
      clientTxId: "",
    });
    expect(errors).toContain("clientTxId is required");
  });

  it("reports missing clientId", () => {
    const errors = MutateService.validateTransaction({
      ...validTx,
      clientId: "",
    });
    expect(errors).toContain("clientId is required");
  });

  it("reports missing modelName", () => {
    const errors = MutateService.validateTransaction({
      ...validTx,
      modelName: "",
    });
    expect(errors).toContain("modelName is required");
  });

  it("reports missing modelId", () => {
    const errors = MutateService.validateTransaction({
      ...validTx,
      modelId: "",
    });
    expect(errors).toContain("modelId is required");
  });

  it("reports invalid action", () => {
    const errors = MutateService.validateTransaction({
      ...validTx,
      action: "INVALID" as TransactionInput["action"],
    });
    expect(errors).toContain("Invalid action: INVALID");
  });
});

// ---------------------------------------------------------------------------
// MutateService.mutate
// ---------------------------------------------------------------------------

describe("MutateService.mutate", () => {
  it("rolls back model writes when sync action creation fails", async () => {
    const { committedWrites, db, transactionCalls } = createMutationDb({
      failSyncActionInsert: true,
    });
    const dao = new SyncDao(db, { syncActions, syncGroupMemberships });
    const service = new MutateService(db, dao, {
      Task: createTaskModelConfig(),
    });

    const result = await service.mutate(
      { groups: [], userId: "user-1" },
      {
        batchId: "batch-1",
        transactions: [
          {
            action: "INSERT",
            clientId: "client-1",
            clientTxId: "tx-1",
            modelId: "task-1",
            modelName: "Task",
            payload: {
              title: "Hello",
              workspaceId: "workspace-1",
            },
          },
        ],
      }
    );

    expect(transactionCalls()).toBe(1);
    expect(committedWrites).toEqual([]);
    expect(result.success).toBeFalsy();
    expect(result.results[0]).toMatchObject({
      clientTxId: "tx-1",
      success: false,
    });
  });

  it("surfaces onAfterMutation warnings on successful transactions", async () => {
    const { committedWrites, db, transactionCalls } = createMutationDb();
    const dao = new SyncDao(db, { syncActions, syncGroupMemberships });
    const service = new MutateService(db, dao, {
      Task: createTaskModelConfig({
        onAfterMutation: () => {
          throw new Error("boom");
        },
      }),
    });

    const result = await service.mutate(
      { groups: [], userId: "user-1" },
      {
        batchId: "batch-1",
        transactions: [
          {
            action: "INSERT",
            clientId: "client-1",
            clientTxId: "tx-1",
            modelId: "task-1",
            modelName: "Task",
            payload: {
              title: "Hello",
              workspaceId: "workspace-1",
            },
          },
        ],
      }
    );

    expect(transactionCalls()).toBe(1);
    expect(committedWrites.map((write) => write.table)).toEqual([
      "tasks",
      "sync_actions",
    ]);
    expect(result.success).toBeTruthy();
    expect(result.results[0]).toMatchObject({
      clientTxId: "tx-1",
      success: true,
      syncId: "7",
      warnings: ["onAfterMutation hook failed: boom"],
    });
  });

  it("checks group access before applying standard updates", async () => {
    const { committedWrites, db, transactionCalls } = createUpdateMutationDb([
      {
        id: "task-1",
        title: "Original",
        workspaceId: "workspace-denied",
      },
    ]);
    const dao = new SyncDao(db, { syncActions, syncGroupMemberships });
    const service = new MutateService(db, dao, {
      Task: createUpdatableTaskModelConfig("workspaceId"),
    });

    const result = await service.mutate(
      { groups: ["workspace-allowed"], userId: "user-1" },
      {
        batchId: "batch-1",
        transactions: [
          {
            action: "UPDATE",
            clientId: "client-1",
            clientTxId: "tx-1",
            modelId: "task-1",
            modelName: "Task",
            payload: {
              title: "Updated",
              workspaceId: "workspace-allowed",
            },
          },
        ],
      }
    );

    expect(transactionCalls()).toBe(1);
    expect(committedWrites).toEqual([]);
    expect(result.success).toBeFalsy();
    expect(result.results[0]).toMatchObject({
      clientTxId: "tx-1",
      error: "Access denied",
      success: false,
    });
  });

  it("fails standard updates when the target record does not exist", async () => {
    const { committedWrites, db } = createUpdateMutationDb([]);
    const dao = new SyncDao(db, { syncActions, syncGroupMemberships });
    const service = new MutateService(db, dao, {
      Task: createUpdatableTaskModelConfig(null),
    });

    const result = await service.mutate(
      { groups: [], userId: "user-1" },
      {
        batchId: "batch-1",
        transactions: [
          {
            action: "UPDATE",
            clientId: "client-1",
            clientTxId: "tx-1",
            modelId: "missing-task",
            modelName: "Task",
            payload: {
              title: "Updated",
            },
          },
        ],
      }
    );

    expect(committedWrites).toEqual([]);
    expect(result.success).toBeFalsy();
    expect(result.results[0]).toMatchObject({
      clientTxId: "tx-1",
      error: "Invalid mutation: record not found",
      success: false,
    });
  });

  it("fails standard updates when the row disappears before the write", async () => {
    const { committedWrites, db } = createUpdateMutationDb(
      [
        {
          id: "task-1",
          title: "Original",
          workspaceId: "workspace-1",
        },
      ],
      { affectedRowCount: 0 }
    );
    const dao = new SyncDao(db, { syncActions, syncGroupMemberships });
    const service = new MutateService(db, dao, {
      Task: createUpdatableTaskModelConfig("workspaceId"),
    });

    const result = await service.mutate(
      { groups: ["workspace-1"], userId: "user-1" },
      {
        batchId: "batch-1",
        transactions: [
          {
            action: "UPDATE",
            clientId: "client-1",
            clientTxId: "tx-1",
            modelId: "task-1",
            modelName: "Task",
            payload: {
              title: "Updated",
            },
          },
        ],
      }
    );

    expect(committedWrites).toEqual([]);
    expect(result.success).toBeFalsy();
    expect(result.results[0]).toMatchObject({
      clientTxId: "tx-1",
      error: "Invalid mutation: record not found",
      success: false,
    });
  });

  it("rejects unknown models instead of creating no-op sync actions", async () => {
    const { committedWrites, db, transactionCalls } = createMutationDb();
    const dao = new SyncDao(db, { syncActions, syncGroupMemberships });
    const service = new MutateService(db, dao, {});

    const result = await service.mutate(
      { groups: [], userId: "user-1" },
      {
        batchId: "batch-1",
        transactions: [
          {
            action: "INSERT",
            clientId: "client-1",
            clientTxId: "tx-1",
            modelId: "ghost-1",
            modelName: "TypoModel",
            payload: {
              title: "Hello",
            },
          },
        ],
      }
    );

    expect(transactionCalls()).toBe(1);
    expect(committedWrites).toEqual([]);
    expect(result.success).toBeFalsy();
    expect(result.results[0]).toMatchObject({
      clientTxId: "tx-1",
      error: "Unknown model: TypoModel",
      success: false,
    });
  });

  it("fails composite deletes when no row matches the payload", async () => {
    const { committedWrites, db, transactionCalls } =
      createCompositeDeleteMutationDb({
        deleteRowCount: 0,
      });
    const dao = new SyncDao(db, { syncActions, syncGroupMemberships });
    const service = new MutateService(db, dao, {
      TaskLabel: createCompositeDeleteModelConfig(),
    });

    const result = await service.mutate(
      { groups: [], userId: "user-1" },
      {
        batchId: "batch-1",
        transactions: [
          {
            action: "DELETE",
            clientId: "client-1",
            clientTxId: "tx-1",
            modelId: "task-1:label-1",
            modelName: "TaskLabel",
            payload: {
              labelId: "label-1",
              taskId: "task-1",
            },
          },
        ],
      }
    );

    expect(transactionCalls()).toBe(1);
    expect(committedWrites).toEqual([]);
    expect(result.success).toBeFalsy();
    expect(result.results[0]).toMatchObject({
      clientTxId: "tx-1",
      error: "Invalid mutation: record not found",
      success: false,
    });
  });
});
