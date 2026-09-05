/* oxlint-disable max-lines -- the six-part group scoping plan lives together */
import { pgTable, text } from "drizzle-orm/pg-core";

import type { SyncModelConfig } from "../../src/config.js";
import { SyncDao } from "../../src/dao/sync-dao.js";
import type { SyncDb } from "../../src/db.js";
import { MutateService } from "../../src/mutate/mutate-service.js";
import type { SyncUserContext, TransactionInput } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  name: text("name"),
  workspaceId: text("workspace_id"),
});

const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  projectId: text("project_id"),
  title: text("title"),
  workspaceId: text("workspace_id"),
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
  groupType: text("group_type"),
  id: text("id").primaryKey(),
  userId: text("user_id"),
});

const TABLE_NAMES = new Map<unknown, string>([
  [projects, "projects"],
  [syncActions, "sync_actions"],
  [syncGroupMemberships, "sync_group_memberships"],
  [tasks, "tasks"],
]);

const tableNameOf = (table: unknown): string =>
  TABLE_NAMES.get(table) ?? "unknown";

// ---------------------------------------------------------------------------
// Test double
//
// Rows are held per table. `where` is ignored (as in the other DAO doubles), so
// seed exactly the row a lookup should find. Model inserts honour the primary
// key, which is what makes the rollback case in part 3 real.
// ---------------------------------------------------------------------------

interface SyncActionRow {
  action: string;
  groupId: string | null;
  model: string;
  modelId: string;
}

interface MembershipRow {
  groupId: string;
  groupType: string;
  userId: string;
}

const createDb = (seed: Record<string, Record<string, unknown>[]> = {}) => {
  const rows: Record<string, Record<string, unknown>[]> = {
    projects: [...(seed.projects ?? [])],
    sync_actions: [],
    sync_group_memberships: [...(seed.sync_group_memberships ?? [])],
    tasks: [...(seed.tasks ?? [])],
  };

  const committed = {
    memberships: [] as MembershipRow[],
    syncActions: [] as SyncActionRow[],
  };

  let nextSyncId = 1n;

  interface Staged {
    memberships: MembershipRow[];
    syncActions: SyncActionRow[];
    modelRows: { table: string; row: Record<string, unknown> }[];
    modelUpdates: { table: string; data: Record<string, unknown> }[];
  }

  const makeDb = (staged: Staged): SyncDb =>
    ({
      delete() {
        return { where: () => Promise.resolve({ rowCount: 1 }) };
      },
      execute() {
        return Promise.resolve([]);
      },
      insert(table) {
        const tableName = tableNameOf(table);
        return {
          values(data: Record<string, unknown>) {
            if (tableName === "sync_actions") {
              const row: SyncActionRow = {
                action: data.action as string,
                groupId: (data.groupId ?? null) as string | null,
                model: data.model as string,
                modelId: data.modelId as string,
              };
              staged.syncActions.push(row);
              const id = nextSyncId;
              nextSyncId += 1n;
              return {
                returning: () =>
                  Promise.resolve([
                    {
                      ...data,
                      createdAt: new Date("2024-06-15T12:00:00.000Z"),
                      id,
                    },
                  ]),
              };
            }

            if (tableName === "sync_group_memberships") {
              const membership: MembershipRow = {
                groupId: data.groupId as string,
                groupType: data.groupType as string,
                userId: data.userId as string,
              };
              const exists = [
                ...rows.sync_group_memberships,
                ...staged.memberships,
              ].some(
                (existing) =>
                  (existing as MembershipRow).userId === membership.userId &&
                  (existing as MembershipRow).groupId === membership.groupId
              );
              return {
                onConflictDoNothing: () => {
                  if (!exists) {
                    staged.memberships.push(membership);
                  }
                  return Promise.resolve();
                },
                returning: () => Promise.resolve([]),
              };
            }

            // Model insert: enforce the primary key so a colliding insert
            // fails the way Postgres would, rolling the transaction back.
            const existing = rows[tableName] ?? [];
            if (existing.some((row) => row.id === data.id)) {
              throw Object.assign(
                new Error(`duplicate key value violates unique constraint`),
                { code: "23505" }
              );
            }
            staged.modelRows.push({ row: data, table: tableName });
            return {
              onConflictDoNothing: () => Promise.resolve(),
              returning: () => Promise.resolve([data]),
            };
          },
        };
      },
      select() {
        return {
          from(table) {
            const tableName = tableNameOf(table);
            const stagedRows = staged.modelRows
              .filter((entry) => entry.table === tableName)
              .map((entry) => entry.row);
            const tableRows = [...(rows[tableName] ?? []), ...stagedRows].map(
              (row) => {
                const updates = staged.modelUpdates.filter(
                  (entry) => entry.table === tableName
                );
                return Object.assign(
                  {},
                  row,
                  ...updates.map(({ data }) => data)
                );
              }
            );
            return {
              where() {
                return {
                  limit: () => Promise.resolve(tableRows),
                  orderBy: () => ({
                    limit: () => Promise.resolve(tableRows),
                  }),
                };
              },
            };
          },
        };
      },
      async transaction(fn) {
        const txStaged: Staged = {
          memberships: [],
          modelRows: [],
          modelUpdates: [],
          syncActions: [],
        };
        const txDb = makeDb(txStaged);

        // A throw propagates without reaching the commit below, so the staged
        // writes are simply discarded — the rollback these tests rely on.
        const result = await fn(txDb);

        committed.memberships.push(...txStaged.memberships);
        committed.syncActions.push(...txStaged.syncActions);
        rows.sync_group_memberships.push(
          ...(txStaged.memberships as unknown as Record<string, unknown>[])
        );
        for (const { row, table } of txStaged.modelRows) {
          rows[table] ??= [];
          rows[table].push(row);
        }
        for (const { data, table } of txStaged.modelUpdates) {
          const [row] = rows[table] ?? [];
          if (row) {
            Object.assign(row, data);
          }
        }

        return result;
      },
      update(table) {
        const tableName = tableNameOf(table);
        return {
          set: (data: Record<string, unknown>) => ({
            where: () => {
              staged.modelUpdates.push({ data, table: tableName });
              return Promise.resolve({ rowCount: 1 });
            },
          }),
        };
      },
    }) as unknown as SyncDb;

  const db = makeDb({
    memberships: [],
    modelRows: [],
    modelUpdates: [],
    syncActions: [],
  });

  return { committed, db, rows };
};

// ---------------------------------------------------------------------------
// Model configs
// ---------------------------------------------------------------------------

const baseBootstrap = {
  buildScopeWhere: () => ({}) as never,
  cursor: { idField: "id", type: "simple" } as const,
  fields: ["id"] as const,
};

/** Today's shape: a single static group column. */
const workspaceScopedTask: SyncModelConfig = {
  bootstrap: baseBootstrap,
  groupKey: "workspaceId",
  mutate: {
    actions: new Set(["I", "U", "D", "A", "V"] as const),
    insertFields: {
      id: { type: "string" },
      projectId: { type: "string" },
      title: { type: "string" },
      workspaceId: { type: "string" },
    },
    kind: "standard",
    updateFields: new Set(["title", "projectId"]),
  },
  table: tasks,
};

/** A project is its own group, and creating one opens that group. */
const selfGroupedProject: SyncModelConfig = {
  bootstrap: baseBootstrap,
  groupKey: null,
  groupType: "project",
  insertCreatesGroup: true,
  mutate: {
    actions: new Set(["I", "U", "D", "A", "V"] as const),
    insertFields: {
      id: { type: "string" },
      name: { type: "string" },
      workspaceId: { type: "string" },
    },
    kind: "standard",
    updateFields: new Set(["name"]),
  },
  resolveGroup: ({ modelId }) => modelId,
  table: projects,
};

/** A task belongs to its project's group — no flag, so it can never open one. */
const projectScopedTask: SyncModelConfig = {
  bootstrap: baseBootstrap,
  groupKey: null,
  mutate: {
    actions: new Set(["I", "U", "D", "A", "V"] as const),
    insertFields: {
      id: { type: "string" },
      projectId: { type: "string" },
      title: { type: "string" },
    },
    kind: "standard",
    updateFields: new Set(["title", "projectId"]),
  },
  resolveGroup: ({ payload, record }) =>
    (payload.projectId ?? record?.projectId ?? null) as string | null,
  table: tasks,
};

const makeContext = (userId: string, groups: string[]): SyncUserContext => ({
  groups: [...groups],
  userId,
});

const makeTx = (
  overrides: Partial<TransactionInput> & Pick<TransactionInput, "modelName">
): TransactionInput => ({
  action: "INSERT",
  clientId: "client-1",
  clientTxId: `tx-${Math.random().toString(36).slice(2)}`,
  modelId: "model-1",
  payload: {},
  ...overrides,
});

const makeService = (
  models: Record<string, SyncModelConfig>,
  db: SyncDb
): MutateService =>
  new MutateService(
    db,
    new SyncDao(db, { syncActions, syncGroupMemberships }),
    models
  );

const run = async (
  service: MutateService,
  context: SyncUserContext,
  transactions: TransactionInput[]
) => await service.mutate(context, { batchId: "batch-1", transactions });

// ---------------------------------------------------------------------------
// 1. Back-compat — resolveGroup absent must behave exactly as before.
// ---------------------------------------------------------------------------

describe("group scoping: back-compat", () => {
  it("still resolves a groupKey model from the insert payload", async () => {
    const { committed, db } = createDb();
    const service = makeService({ Task: workspaceScopedTask }, db);

    const result = await run(service, makeContext("user-a", ["ws-1"]), [
      makeTx({
        modelId: "task-1",
        modelName: "Task",
        payload: { id: "task-1", title: "Hi", workspaceId: "ws-1" },
      }),
    ]);

    expect(result.success).toBeTruthy();
    expect(committed.syncActions).toHaveLength(1);
    expect(committed.syncActions[0]?.groupId).toBe("ws-1");
    expect(committed.memberships).toHaveLength(0);
  });

  it("still resolves a groupKey model from the existing row on update", async () => {
    const { committed, db } = createDb({
      tasks: [{ id: "task-1", title: "Hi", workspaceId: "ws-1" }],
    });
    const service = makeService({ Task: workspaceScopedTask }, db);

    const result = await run(service, makeContext("user-a", ["ws-1"]), [
      makeTx({
        action: "UPDATE",
        modelId: "task-1",
        modelName: "Task",
        payload: { title: "Renamed" },
      }),
    ]);

    expect(result.success).toBeTruthy();
    expect(committed.syncActions[0]?.groupId).toBe("ws-1");
  });

  it("still denies a write to a group the caller does not hold", async () => {
    const { db } = createDb();
    const service = makeService({ Task: workspaceScopedTask }, db);

    const result = await run(service, makeContext("user-b", ["ws-2"]), [
      makeTx({
        modelId: "task-1",
        modelName: "Task",
        payload: { id: "task-1", title: "Hi", workspaceId: "ws-1" },
      }),
    ]);

    expect(result.success).toBeFalsy();
    expect(result.results[0]?.error).toBe("Access denied");
  });

  it("still treats groupKey: null as ungrouped", async () => {
    const { committed, db } = createDb();
    const ungrouped: SyncModelConfig = {
      ...workspaceScopedTask,
      groupKey: null,
    };
    const service = makeService({ Task: ungrouped }, db);

    const result = await run(service, makeContext("user-a", []), [
      makeTx({
        modelId: "task-1",
        modelName: "Task",
        payload: { id: "task-1", title: "Hi" },
      }),
    ]);

    expect(result.success).toBeTruthy();
    expect(committed.syncActions[0]?.groupId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. resolveGroup precedence.
// ---------------------------------------------------------------------------

describe("group scoping: resolveGroup precedence", () => {
  it("wins over groupKey when both are set", async () => {
    const { committed, db } = createDb();
    const model: SyncModelConfig = {
      ...workspaceScopedTask,
      resolveGroup: () => "hook-group",
    };
    const service = makeService({ Task: model }, db);

    const result = await run(
      service,
      makeContext("user-a", ["ws-1", "hook-group"]),
      [
        makeTx({
          modelId: "task-1",
          modelName: "Task",
          payload: { id: "task-1", title: "Hi", workspaceId: "ws-1" },
        }),
      ]
    );

    expect(result.success).toBeTruthy();
    expect(committed.syncActions[0]?.groupId).toBe("hook-group");
  });

  it("returning null means ungrouped, as groupKey: null does", async () => {
    const { committed, db } = createDb();
    const model: SyncModelConfig = {
      ...workspaceScopedTask,
      resolveGroup: () => null,
    };
    const service = makeService({ Task: model }, db);

    const result = await run(service, makeContext("user-a", []), [
      makeTx({
        modelId: "task-1",
        modelName: "Task",
        payload: { id: "task-1", title: "Hi", workspaceId: "ws-1" },
      }),
    ]);

    expect(result.success).toBeTruthy();
    expect(committed.syncActions[0]?.groupId).toBeNull();
  });

  it("receives the existing row on a non-insert and no row on an insert", async () => {
    const { db } = createDb({
      tasks: [{ id: "task-1", projectId: "proj-9", workspaceId: "ws-1" }],
    });
    const seen: { action: string; record: unknown }[] = [];
    const model: SyncModelConfig = {
      ...workspaceScopedTask,
      resolveGroup: ({ action, record }) => {
        seen.push({ action, record });
        return "ws-1";
      },
    };
    const service = makeService({ Task: model }, db);

    await run(service, makeContext("user-a", ["ws-1"]), [
      makeTx({
        modelId: "task-2",
        modelName: "Task",
        payload: { id: "task-2", title: "New", workspaceId: "ws-1" },
      }),
      makeTx({
        action: "UPDATE",
        modelId: "task-1",
        modelName: "Task",
        payload: { title: "Renamed" },
      }),
    ]);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ action: "I", record: null });
    expect(seen[1]?.action).toBe("U");
    expect(seen[1]?.record).toMatchObject({
      id: "task-1",
      projectId: "proj-9",
    });
  });

  it("can route a task to its project, else the creator's own group", async () => {
    const { committed, db } = createDb();
    const model: SyncModelConfig = {
      ...workspaceScopedTask,
      resolveGroup: ({ context, payload, record }) =>
        (payload.projectId as string | null) ??
        (record?.projectId as string | null) ??
        context.userId,
    };
    const service = makeService({ Task: model }, db);

    const result = await run(
      service,
      makeContext("user-a", ["ws-1", "user-a", "proj-1"]),
      [
        makeTx({
          modelId: "task-1",
          modelName: "Task",
          payload: { id: "task-1", projectId: "proj-1", title: "In project" },
        }),
        makeTx({
          modelId: "task-2",
          modelName: "Task",
          payload: { id: "task-2", title: "Inbox" },
        }),
      ]
    );

    expect(result.success).toBeTruthy();
    expect(committed.syncActions.map((row) => row.groupId)).toEqual([
      "proj-1",
      "user-a",
    ]);
  });
});

describe("group scoping: publication audience", () => {
  it("resolves the published group from post-mutation data without widening write access", async () => {
    const { committed, db } = createDb();
    const seen: (Record<string, unknown> | null)[] = [];
    const model: SyncModelConfig = {
      ...workspaceScopedTask,
      resolveGroup: ({ payload }) => payload.workspaceId as string,
      resolvePublishGroup: ({ record }) => {
        seen.push(record);
        return record?.projectId as string;
      },
    };
    const service = makeService({ Task: model }, db);

    const result = await run(service, makeContext("user-a", ["ws-1"]), [
      makeTx({
        modelId: "task-1",
        modelName: "Task",
        payload: {
          id: "task-1",
          projectId: "private-project",
          title: "Moved",
          workspaceId: "ws-1",
        },
      }),
    ]);

    expect(result.success).toBeTruthy();
    expect(seen[0]).toMatchObject({
      id: "task-1",
      projectId: "private-project",
    });
    expect(committed.syncActions[0]?.groupId).toBe("private-project");
  });

  it("reloads the complete row after a partial update", async () => {
    const { committed, db } = createDb({
      tasks: [
        {
          id: "task-1",
          projectId: "project-1",
          title: "Before",
          workspaceId: "ws-1",
        },
      ],
    });
    let publishedRecord: Record<string, unknown> | null = null;
    const model: SyncModelConfig = {
      ...workspaceScopedTask,
      resolvePublishGroup: ({ record }) => {
        publishedRecord = record;
        return record?.workspaceId as string;
      },
    };
    const service = makeService({ Task: model }, db);

    const result = await run(service, makeContext("user-a", ["ws-1"]), [
      makeTx({
        action: "UPDATE",
        modelId: "task-1",
        modelName: "Task",
        payload: { title: "After" },
      }),
    ]);

    expect(result.success).toBeTruthy();
    expect(publishedRecord).toMatchObject({
      id: "task-1",
      projectId: "project-1",
      title: "After",
      workspaceId: "ws-1",
    });
    expect(committed.syncActions[0]?.groupId).toBe("ws-1");
  });

  it("uses the complete pre-mutation row for a delete", async () => {
    const { committed, db } = createDb({
      tasks: [
        {
          id: "task-1",
          projectId: "project-1",
          title: "Before",
          workspaceId: "ws-1",
        },
      ],
    });
    let publishedRecord: Record<string, unknown> | null = null;
    const model: SyncModelConfig = {
      ...workspaceScopedTask,
      resolvePublishGroup: ({ record }) => {
        publishedRecord = record;
        return record?.workspaceId as string;
      },
    };
    const service = makeService({ Task: model }, db);

    const result = await run(service, makeContext("user-a", ["ws-1"]), [
      makeTx({
        action: "DELETE",
        modelId: "task-1",
        modelName: "Task",
      }),
    ]);

    expect(result.success).toBeTruthy();
    expect(publishedRecord).toMatchObject({
      id: "task-1",
      projectId: "project-1",
      title: "Before",
      workspaceId: "ws-1",
    });
    expect(committed.syncActions[0]?.groupId).toBe("ws-1");
  });

  it("rolls back the model mutation when post-mutation resolution fails", async () => {
    const { committed, db, rows } = createDb();
    const model: SyncModelConfig = {
      ...workspaceScopedTask,
      resolvePublishGroup: () => {
        throw new Error("publication group unavailable");
      },
    };
    const service = makeService({ Task: model }, db);

    const result = await run(service, makeContext("user-a", ["ws-1"]), [
      makeTx({
        modelId: "task-1",
        modelName: "Task",
        payload: { id: "task-1", title: "Hi", workspaceId: "ws-1" },
      }),
    ]);

    expect(result.success).toBeFalsy();
    expect(result.results[0]?.error).toBe("publication group unavailable");
    expect(rows.tasks).toHaveLength(0);
    expect(committed.syncActions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. insertCreatesGroup.
// ---------------------------------------------------------------------------

describe("group scoping: insertCreatesGroup", () => {
  it("lets a creator open the group their insert resolves to", async () => {
    const { committed, db } = createDb();
    const service = makeService({ Project: selfGroupedProject }, db);
    const context = makeContext("user-a", ["ws-1"]);

    const result = await run(service, context, [
      makeTx({
        modelId: "proj-1",
        modelName: "Project",
        payload: { id: "proj-1", name: "Private", workspaceId: "ws-1" },
      }),
    ]);

    expect(result.success).toBeTruthy();
    expect(committed.syncActions[0]?.groupId).toBe("proj-1");
    expect(committed.memberships).toEqual([
      { groupId: "proj-1", groupType: "project", userId: "user-a" },
    ]);
    // The caller's context is an input, not a scratchpad. The grant is real —
    // a committed membership row their next authorize picks up — but it does
    // not reach back into the object they passed in.
    expect(context.groups).toEqual(["ws-1"]);
  });

  it("refuses at startup to guess a groupType", async () => {
    // groupType lands in a table the consumer owns, so the engine will not
    // invent one. Failing here beats writing a wrong value at 3am.
    const { db } = createDb();
    const model: SyncModelConfig = { ...selfGroupedProject };
    delete model.groupType;

    expect(() => makeService({ Project: model }, db)).toThrow(
      /insertCreatesGroup but no groupType/
    );
    await Promise.resolve();
  });

  it("lets a later transaction in the same batch write to the opened group", async () => {
    // The grant has to be visible for the rest of the batch, or the very
    // common "create a project and put something in it" round trip fails on
    // its second transaction.
    const { committed, db } = createDb();
    const service = makeService(
      { Project: selfGroupedProject, Task: projectScopedTask },
      db
    );

    const result = await run(service, makeContext("user-a", ["ws-1"]), [
      makeTx({
        modelId: "proj-1",
        modelName: "Project",
        payload: { id: "proj-1", name: "Private", workspaceId: "ws-1" },
      }),
      makeTx({
        modelId: "task-1",
        modelName: "Task",
        payload: { id: "task-1", projectId: "proj-1", title: "In it" },
      }),
    ]);

    expect(result.success).toBeTruthy();
    expect(committed.syncActions.map((row) => row.groupId)).toEqual([
      "proj-1",
      "proj-1",
    ]);
  });

  it("does not re-grant a group the creator already holds", async () => {
    const { committed, db } = createDb();
    const service = makeService({ Project: selfGroupedProject }, db);

    await run(service, makeContext("user-a", ["ws-1", "proj-1"]), [
      makeTx({
        modelId: "proj-1",
        modelName: "Project",
        payload: { id: "proj-1", name: "Private", workspaceId: "ws-1" },
      }),
    ]);

    expect(committed.memberships).toHaveLength(0);
    expect(committed.syncActions[0]?.groupId).toBe("proj-1");
  });

  it("commits no membership when the insert itself fails", async () => {
    // A non-member inserting into an existing group can only do so by
    // colliding with the existing row's primary key. The membership is written
    // in the same transaction, so the collision rolls it back too.
    const { committed, db } = createDb({
      projects: [{ id: "proj-1", name: "Private", workspaceId: "ws-1" }],
    });
    const service = makeService({ Project: selfGroupedProject }, db);
    const context = makeContext("user-b", ["ws-1"]);

    const result = await run(service, context, [
      makeTx({
        modelId: "proj-1",
        modelName: "Project",
        payload: { id: "proj-1", name: "Hijack", workspaceId: "ws-1" },
      }),
    ]);

    expect(result.success).toBeFalsy();
    expect(committed.memberships).toHaveLength(0);
    expect(committed.syncActions).toHaveLength(0);
    expect(context.groups).not.toContain("proj-1");
  });

  it("is off by default: an insert into an unheld group is denied", async () => {
    const { committed, db } = createDb();
    const model: SyncModelConfig = { ...selfGroupedProject };
    delete model.insertCreatesGroup;
    const service = makeService({ Project: model }, db);

    const result = await run(service, makeContext("user-a", ["ws-1"]), [
      makeTx({
        modelId: "proj-1",
        modelName: "Project",
        payload: { id: "proj-1", name: "Private", workspaceId: "ws-1" },
      }),
    ]);

    expect(result.success).toBeFalsy();
    expect(result.results[0]?.error).toBe("Access denied");
    expect(committed.memberships).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. The write invariant is preserved.
// ---------------------------------------------------------------------------

describe("group scoping: write invariant", () => {
  const nonInserts = [
    { action: "UPDATE" as const, payload: { name: "Renamed" } },
    { action: "DELETE" as const, payload: {} },
    { action: "ARCHIVE" as const, payload: {} },
    { action: "UNARCHIVE" as const, payload: {} },
  ];

  for (const { action, payload } of nonInserts) {
    it(`denies ${action} into a group the caller does not hold, with the new flags set`, async () => {
      const { committed, db } = createDb({
        projects: [{ id: "proj-1", name: "Private", workspaceId: "ws-1" }],
      });
      const service = makeService({ Project: selfGroupedProject }, db);
      const context = makeContext("user-b", ["ws-1"]);

      const result = await run(service, context, [
        makeTx({
          action,
          modelId: "proj-1",
          modelName: "Project",
          payload,
        }),
      ]);

      expect(result.success).toBeFalsy();
      expect(result.results[0]?.error).toBe("Access denied");
      expect(committed.memberships).toHaveLength(0);
      expect(committed.syncActions).toHaveLength(0);
      expect(context.groups).not.toContain("proj-1");
    });

    it(`denies ${action} into a group the caller does not hold, without the new flags`, async () => {
      const { committed, db } = createDb({
        tasks: [{ id: "task-1", title: "Hi", workspaceId: "ws-1" }],
      });
      const service = makeService({ Task: workspaceScopedTask }, db);

      const result = await run(service, makeContext("user-b", ["ws-2"]), [
        makeTx({
          action,
          modelId: "task-1",
          modelName: "Task",
          payload,
        }),
      ]);

      expect(result.success).toBeFalsy();
      expect(result.results[0]?.error).toBe("Access denied");
      expect(committed.syncActions).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Leak regression.
//
// The delta feed is filtered by the groupId stamped on each sync action, so the
// property that keeps a private row private is that *every* action for it —
// insert and every subsequent edit — carries the private group and never the
// shared workspace group that both users hold.
// ---------------------------------------------------------------------------

describe("group scoping: leak regression", () => {
  it("stamps the private group on every action for the row, never the workspace", async () => {
    const { committed, db } = createDb();
    const service = makeService({ Project: selfGroupedProject }, db);

    const userA = makeContext("user-a", ["ws-1"]);
    const userB = makeContext("user-b", ["ws-1"]);

    await run(service, userA, [
      makeTx({
        modelId: "proj-1",
        modelName: "Project",
        payload: { id: "proj-1", name: "Private", workspaceId: "ws-1" },
      }),
      ...["Edit 1", "Edit 2", "Edit 3"].map((name) =>
        makeTx({
          action: "UPDATE" as const,
          modelId: "proj-1",
          modelName: "Project",
          payload: { name },
        })
      ),
    ]);

    expect(committed.syncActions).toHaveLength(4);
    for (const row of committed.syncActions) {
      expect(row.groupId).toBe("proj-1");
      expect(row.groupId).not.toBe("ws-1");
    }

    // User B shares the workspace but was never granted the project group, so
    // none of those actions fall inside the groups their delta fetch reads.
    expect(userB.groups).toEqual(["ws-1"]);
    const visibleToB = committed.syncActions.filter(
      (row) => row.groupId === null || userB.groups.includes(row.groupId)
    );
    expect(visibleToB).toHaveLength(0);
  });

  it("keeps a workspace-scoped model visible to the whole workspace", async () => {
    const { committed, db } = createDb();
    const service = makeService({ Task: workspaceScopedTask }, db);
    const userB = makeContext("user-b", ["ws-1"]);

    await run(service, makeContext("user-a", ["ws-1"]), [
      makeTx({
        modelId: "task-1",
        modelName: "Task",
        payload: { id: "task-1", title: "Shared", workspaceId: "ws-1" },
      }),
    ]);

    const visibleToB = committed.syncActions.filter(
      (row) => row.groupId !== null && userB.groups.includes(row.groupId)
    );
    expect(visibleToB).toHaveLength(1);
  });
});
