/* eslint-disable promise/prefer-await-to-callbacks -- test double matches SyncDb.transaction signature */
import { sql } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";

import { BootstrapService } from "../../src/bootstrap/bootstrap-service.js";
import type { SyncModelConfig } from "../../src/config.js";
import type { SyncDb } from "../../src/db.js";

const numericTasks = pgTable("numeric_tasks", {
  sequence: integer("sequence"),
  title: text("title"),
});

const namedTasks = pgTable("named_tasks", {
  taskId: text("task_id").primaryKey(),
  title: text("title"),
});

const createBootstrapDb = (
  pagesByTable: Record<string, Record<string, unknown>[][]>,
  countsByTable: Record<string, number>
): SyncDb => {
  const bootstrapPageSize = 1000;
  const rowCallCounts = new Map<string, number>();
  const getTableName = (table: unknown): string => {
    if (table === numericTasks) {
      return "numeric_tasks";
    }
    if (table === namedTasks) {
      return "named_tasks";
    }
    return "unknown";
  };
  const getPagedRows = (tableName: string): Record<string, unknown>[] => {
    const pages = pagesByTable[tableName] ?? [];
    if (pages.length === 0) {
      return [];
    }

    const pageIndex = rowCallCounts.get(tableName) ?? 0;
    const page = pages[pageIndex] ?? [];

    if (
      page.length === 0 ||
      page.length < bootstrapPageSize ||
      pageIndex >= pages.length - 1
    ) {
      rowCallCounts.set(tableName, 0);
    } else {
      rowCallCounts.set(tableName, pageIndex + 1);
    }

    return page;
  };

  return {
    delete() {
      throw new Error("delete is not used in bootstrap tests");
    },
    insert() {
      throw new Error("insert is not used in bootstrap tests");
    },
    select(fields?: Record<string, unknown>) {
      return {
        from(table) {
          const tableName = getTableName(table);
          return {
            where() {
              return {
                limit() {
                  if (fields && "count" in fields) {
                    return Promise.resolve([
                      { count: countsByTable[tableName] ?? 0 },
                    ]);
                  }

                  return Promise.resolve(getPagedRows(tableName));
                },
                orderBy() {
                  return {
                    limit() {
                      if (fields && "count" in fields) {
                        return Promise.resolve([
                          { count: countsByTable[tableName] ?? 0 },
                        ]);
                      }

                      return Promise.resolve(getPagedRows(tableName));
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
      return callback(this);
    },
    update() {
      throw new Error("update is not used in bootstrap tests");
    },
  };
};

const collectLines = async (
  generator: AsyncGenerator<string, void, unknown>
): Promise<string[]> => {
  const lines: string[] = [];
  for await (const line of generator) {
    lines.push(line);
  }
  return lines;
};

describe(BootstrapService, () => {
  it("continues simple-cursor pagination when the cursor field is numeric", async () => {
    const page1 = Array.from({ length: 1000 }, (_, index) => ({
      sequence: index + 1,
      title: `Task ${index + 1}`,
    }));
    const page2 = [{ sequence: 1001, title: "Task 1001" }];
    const db = createBootstrapDb(
      {
        numeric_tasks: [page1, page2, []],
      },
      { numeric_tasks: 1001 }
    );
    const dao = {
      getLastSyncIdForGroups: vi.fn().mockResolvedValue(0n),
      getTouchedModelIdsAfter: vi.fn().mockResolvedValue(new Set<string>()),
    };
    const models: Record<string, SyncModelConfig> = {
      NumericTask: {
        bootstrap: {
          buildScopeWhere: () => sql`true`,
          cursor: { idField: "sequence", type: "simple" },
          fields: ["sequence", "title"],
        },
        groupKey: null,
        mutate: {
          actions: new Set(["I"]),
          idField: "sequence",
          insertFields: {
            title: { type: "string" },
          },
          kind: "standard",
        },
        table: numericTasks,
      },
    };

    const service = new BootstrapService(db, dao as never, models);
    const lines = await collectLines(
      service.generateBootstrapNdjson(
        { groups: [], userId: "user-1" },
        { schemaHash: "schema-1" }
      )
    );

    expect(lines).toHaveLength(1002);
    expect(lines[0]).toContain('"returnedModelsCount":{"NumericTask":1001}');
    expect(lines.at(-1)).toContain('"sequence":1001');
  });

  it("filters touched rows during bootstrap even when the primary key is not named id", async () => {
    const touchedCalls: {
      firstSyncId: bigint;
      groups: string[];
      modelIds: string[];
      modelName: string;
    }[] = [];
    const db = createBootstrapDb(
      {
        named_tasks: [
          [
            { taskId: "task-1", title: "Keep me" },
            { taskId: "task-2", title: "Changed later" },
          ],
          [],
        ],
      },
      { named_tasks: 2 }
    );
    const dao = {
      getLastSyncIdForGroups: vi.fn().mockResolvedValue(7n),
      getTouchedModelIdsAfter: vi.fn(
        (
          firstSyncId: bigint,
          groups: string[],
          modelName: string,
          modelIds: string[]
        ) => {
          touchedCalls.push({ firstSyncId, groups, modelIds, modelName });
          return Promise.resolve(new Set(["task-2"]));
        }
      ),
    };
    const models: Record<string, SyncModelConfig> = {
      NamedTask: {
        bootstrap: {
          buildScopeWhere: () => sql`true`,
          cursor: { idField: "taskId", type: "simple" },
          fields: ["title"],
        },
        groupKey: null,
        mutate: {
          actions: new Set(["I"]),
          idField: "taskId",
          insertFields: {
            title: { type: "string" },
          },
          kind: "standard",
        },
        table: namedTasks,
      },
    };

    const service = new BootstrapService(db, dao as never, models);
    const lines = await collectLines(
      service.generateBootstrapNdjson(
        { groups: ["workspace-1"], userId: "user-1" },
        { schemaHash: "schema-1" }
      )
    );

    expect(touchedCalls).toEqual([
      {
        firstSyncId: 7n,
        groups: ["workspace-1"],
        modelIds: ["task-1", "task-2"],
        modelName: "NamedTask",
      },
      {
        firstSyncId: 7n,
        groups: ["workspace-1"],
        modelIds: ["task-1", "task-2"],
        modelName: "NamedTask",
      },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"returnedModelsCount":{"NamedTask":1}');
    expect(lines[1]).toContain('"id":"task-1"');
    expect(lines[1]).toContain('"title":"Keep me"');
  });

  it("filters touched rows during bootstrap when the row id is numeric", async () => {
    const touchedCalls: {
      firstSyncId: bigint;
      groups: string[];
      modelIds: string[];
      modelName: string;
    }[] = [];
    const db = createBootstrapDb(
      {
        numeric_tasks: [
          [
            { sequence: 1, title: "Keep me" },
            { sequence: 2, title: "Changed later" },
          ],
          [],
        ],
      },
      { numeric_tasks: 2 }
    );
    const dao = {
      getLastSyncIdForGroups: vi.fn().mockResolvedValue(9n),
      getTouchedModelIdsAfter: vi.fn(
        (
          firstSyncId: bigint,
          groups: string[],
          modelName: string,
          modelIds: string[]
        ) => {
          touchedCalls.push({ firstSyncId, groups, modelIds, modelName });
          return Promise.resolve(new Set(["2"]));
        }
      ),
    };
    const models: Record<string, SyncModelConfig> = {
      NumericTask: {
        bootstrap: {
          buildScopeWhere: () => sql`true`,
          cursor: { idField: "sequence", type: "simple" },
          fields: ["sequence", "title"],
        },
        groupKey: null,
        mutate: {
          actions: new Set(["I"]),
          idField: "sequence",
          insertFields: {
            title: { type: "string" },
          },
          kind: "standard",
        },
        table: numericTasks,
      },
    };

    const service = new BootstrapService(db, dao as never, models);
    const lines = await collectLines(
      service.generateBootstrapNdjson(
        { groups: ["workspace-1"], userId: "user-1" },
        { schemaHash: "schema-1" }
      )
    );

    expect(touchedCalls).toEqual([
      {
        firstSyncId: 9n,
        groups: ["workspace-1"],
        modelIds: ["1", "2"],
        modelName: "NumericTask",
      },
      {
        firstSyncId: 9n,
        groups: ["workspace-1"],
        modelIds: ["1", "2"],
        modelName: "NumericTask",
      },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"returnedModelsCount":{"NumericTask":1}');
    expect(lines[1]).toContain('"id":1');
    expect(lines[1]).toContain('"sequence":1');
    expect(lines[1]).toContain('"title":"Keep me"');
  });
});
