/**
 * Concurrency properties of MutateService that the formal model in
 * verification/lean/StrataSync/Server.lean relies on:
 *
 * 1. Two concurrent submissions of the same (clientId, clientTxId) produce one
 *    sync action AND both report success — the loser of the insert race must
 *    recognise the dedup unique violation as it actually arrives from
 *    drizzle-orm 1.x + postgres.js: wrapped in a DrizzleQueryError whose
 *    `cause` carries `constraint_name`.
 * 2. Committed sync actions are handed to `onAction` (the live publish) in
 *    syncId order. A live WebSocket session advances its cursor to the highest
 *    syncId it delivered and drops anything at or below it, so a lower syncId
 *    published after a higher one is lost for good.
 */
import { DrizzleQueryError, sql } from "drizzle-orm";
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

const syncActions = pgTable("sync_actions", {
  action: text("action"),
  clientId: text("client_id"),
  clientTxId: text("client_tx_id"),
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

const createDeferred = () => {
  let resolve!: () => void;
  // oxlint-disable-next-line avoid-new, param-names -- deferred promise pattern
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const taskModel = (
  onAfterMutation?: NonNullable<SyncModelConfig["mutate"]>["onAfterMutation"]
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
    ...(onAfterMutation ? { onAfterMutation } : {}),
  },
  table: tasks,
});

const insertTx = (clientTxId: string, modelId: string): TransactionInput => ({
  action: "INSERT",
  clientId: "client-1",
  clientTxId,
  modelId,
  modelName: "Task",
  payload: { title: "Hello", workspaceId: "workspace-1" },
});

/**
 * A fake database that behaves like Postgres under the DAO's insert-order
 * advisory lock: transactions touching sync_actions are serialised and each
 * sync action gets the next id, so ids are allocated in commit order.
 */
const createSequencedDb = (options?: {
  /** Rows returned by the dedup lookup, per call. */
  dedupLookups?: Record<string, unknown>[][];
  /** Error thrown when a transaction inserts its sync action. */
  syncActionInsertError?: unknown;
}) => {
  let nextId = 1n;
  let transactionChain: Promise<unknown> = Promise.resolve();
  let lookupCall = 0;

  const makeDb = (): SyncDb =>
    ({
      delete() {
        throw new Error("delete is not used in these tests");
      },
      execute() {
        return Promise.resolve([]);
      },
      insert(table: unknown) {
        return {
          values(data: Record<string, unknown>) {
            if (table !== syncActions) {
              return Promise.resolve();
            }
            return {
              returning() {
                if (options?.syncActionInsertError) {
                  return Promise.reject(options.syncActionInsertError);
                }
                const id = nextId;
                nextId += 1n;
                return Promise.resolve([
                  {
                    ...data,
                    createdAt: new Date("2024-06-15T12:00:00.000Z"),
                    id,
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
                const rows = options?.dedupLookups?.[lookupCall] ?? [];
                lookupCall += 1;
                return {
                  limit: () => Promise.resolve(rows),
                  orderBy: () => ({ limit: () => Promise.resolve(rows) }),
                };
              },
            };
          },
        };
      },
      transaction(fn: (tx: SyncDb) => Promise<unknown>) {
        const run = transactionChain.then(() => fn(makeDb()));
        transactionChain = run.catch(() => null);
        return run;
      },
      update() {
        throw new Error("update is not used in these tests");
      },
    }) as unknown as SyncDb;

  return makeDb();
};

describe("MutateService concurrency", () => {
  it("treats a driver-wrapped dedup unique violation as a duplicate, not a failure", async () => {
    // Exactly the shape drizzle-orm 1.x + postgres.js produce for the losing
    // insert of a (clientId, clientTxId) race (verified against Postgres 16).
    const pgError = Object.assign(
      new Error(
        'duplicate key value violates unique constraint "sync_actions_client_id_client_tx_id_unique"'
      ),
      {
        code: "23505",
        constraint_name: "sync_actions_client_id_client_tx_id_unique",
      }
    );
    const wrapped = new DrizzleQueryError(
      "insert into sync_actions ...",
      [],
      pgError
    );
    const db = createSequencedDb({
      // Pre-check sees nothing (the winner has not committed yet); the
      // post-conflict lookup finds the winner's row.
      dedupLookups: [[], [{ id: 42n }]],
      syncActionInsertError: wrapped,
    });
    const dao = new SyncDao(db, { syncActions, syncGroupMemberships });
    const service = new MutateService(db, dao, { Task: taskModel() });
    const onAction = vi.fn();

    const result = await service.mutate(
      { groups: [], userId: "user-1" },
      { batchId: "b", transactions: [insertTx("tx-1", "task-1")] },
      onAction
    );

    expect(result.success).toBeTruthy();
    expect(result.results[0]).toMatchObject({
      clientTxId: "tx-1",
      success: true,
      syncId: "42",
    });
    // The duplicate is not re-published.
    expect(onAction).not.toHaveBeenCalled();
  });

  it("publishes committed sync actions in syncId order across concurrent requests", async () => {
    const hookGate = createDeferred();
    let hookCalls = 0;
    const db = createSequencedDb();
    const dao = new SyncDao(db, { syncActions, syncGroupMemberships });
    const service = new MutateService(db, dao, {
      Task: taskModel(async () => {
        hookCalls += 1;
        // The first request's post-commit hook is slow.
        if (hookCalls === 1) {
          await hookGate.promise;
        }
      }),
    });
    const published: string[] = [];
    const onAction = (action: { syncId: string }) => {
      published.push(action.syncId);
    };

    const first = service.mutate(
      { groups: [], userId: "user-1" },
      { batchId: "b1", transactions: [insertTx("tx-1", "task-1")] },
      onAction
    );
    const second = service.mutate(
      { groups: [], userId: "user-1" },
      { batchId: "b2", transactions: [insertTx("tx-2", "task-2")] },
      onAction
    );

    const secondResult = await second;
    expect(secondResult.lastSyncId).toBe("2");
    hookGate.resolve();
    const firstResult = await first;
    expect(firstResult.lastSyncId).toBe("1");

    // Commit order is 1 then 2; the live stream must see them in that order.
    expect(published).toEqual(["1", "2"]);
  });
});
