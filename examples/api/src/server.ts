import "dotenv/config";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { SyncModelConfig } from "@stratasync/server";
import { SyncDao, createSyncServer } from "@stratasync/server";
import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import Fastify from "fastify";
import postgres from "postgres";

import { DEV_GROUP_ID, DEV_TOKEN, DEV_USER_ID } from "./config.js";
import { syncActions, syncGroupMemberships, todos } from "./db/schema.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const queryClient = postgres(databaseUrl);
const db = drizzle({ client: queryClient });

await db
  .insert(syncGroupMemberships)
  .values({
    groupId: DEV_GROUP_ID,
    groupType: "workspace",
    userId: DEV_USER_ID,
  })
  .onConflictDoNothing({
    target: [syncGroupMemberships.userId, syncGroupMemberships.groupId],
  });

const syncDao = new SyncDao(db, { syncActions, syncGroupMemberships });

const todoConfig: SyncModelConfig = {
  bootstrap: {
    buildScopeWhere: (filter, _db) =>
      filter.workspaceGroupIds.length > 0
        ? inArray(todos.groupId, filter.workspaceGroupIds)
        : sql`false`,
    cursor: { idField: "id", type: "simple" },
    fields: ["id", "title", "completed", "createdAt", "groupId"],
    instantFields: ["createdAt"],
  },
  groupKey: "groupId",
  mutate: {
    actions: new Set(["I", "U", "D"]),
    insertFields: {
      completed: { type: "string" },
      createdAt: { type: "date" },
      groupId: { type: "string" },
      title: { type: "string" },
    },
    kind: "standard",
    updateFields: new Set(["title", "completed"]),
  },
  table: todos,
};

const sync = await createSyncServer({
  auth: {
    resolveGroups: (userId) => syncDao.getUserGroups(userId),
    verifyToken: (token) =>
      token === DEV_TOKEN ? { userId: DEV_USER_ID } : null,
  },
  db,
  models: {
    Todo: todoConfig,
  },
  tables: {
    syncActions,
    syncGroupMemberships,
  },
});

const fastify = Fastify({
  logger: true,
});

await fastify.register(cors, { origin: true });
await fastify.register(websocket);

fastify.get("/health", () => ({
  ok: true,
}));

sync.registerRoutes(fastify);

const shutdown = async () => {
  await fastify.close();
  await sync.shutdown();
  await queryClient.end();
};

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});

const address = await fastify.listen({
  host: "0.0.0.0",
  port: 3001,
});

fastify.log.info({ address }, "Example sync API listening");
