# Server Setup Reference

All code templates for the standalone Fastify sync server. Replace `{{placeholders}}` with actual values.

---

## package.json

`server/package.json`

```json
{
  "name": "{{PROJECT_NAME}}-server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "db:push": "drizzle-kit push",
    "db:generate": "drizzle-kit generate"
  },
  "dependencies": {
    "@fastify/cors": "^11.2.0",
    "@fastify/websocket": "^11.2.0",
    "@stratasync/server": "latest",
    "dotenv": "^17.3.1",
    "drizzle-orm": "1.0.0-beta.15-859cf75",
    "fastify": "^5.8.2",
    "postgres": "^3.4.8"
  },
  "devDependencies": {
    "@types/node": "^25.5.0",
    "drizzle-kit": "^0.31.10",
    "tsx": "^4.21.0",
    "typescript": "^5.9.3"
  }
}
```

---

## tsconfig.json

`server/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2024"],
    "types": ["node"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "isolatedModules": true
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules"]
}
```

---

## docker-compose.yml

`server/docker-compose.yml`

```yaml
services:
  postgres:
    image: postgres:17-alpine
    ports:
      - "5432:5432"
    environment:
      POSTGRES_DB: { { PROJECT_NAME } }
      POSTGRES_PASSWORD: postgres
      POSTGRES_USER: postgres
    volumes:
      - postgres-data:/var/lib/postgresql/data

volumes:
  postgres-data:
```

---

## .env

`server/.env`

```
DATABASE_URL=postgres://postgres:postgres@localhost:5432/{{PROJECT_NAME}}
```

---

## drizzle.config.ts

`server/drizzle.config.ts`

```ts
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5432/{{PROJECT_NAME}}",
  },
  dialect: "postgresql",
  out: "./drizzle",
  schema: "./src/db/schema.ts",
});
```

---

## Drizzle schema

`server/src/db/schema.ts`

The model table matches the client model fields. `syncActions` and `syncGroupMemberships` are required by StrataSync.

```ts
import {
  bigserial,
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const {{MODEL_TABLE}} = pgTable("{{MODEL_TABLE}}", {
  completed: boolean("completed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  groupId: text("group_id").notNull(),
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
});

export const syncActions = pgTable(
  "sync_actions",
  {
    action: text("action").notNull(),
    clientId: text("client_id"),
    clientTxId: text("client_tx_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    groupId: text("group_id"),
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    model: text("model").notNull(),
    modelId: text("model_id").notNull(),
  },
  (table) => ({
    clientTxUnique: uniqueIndex("sync_actions_client_tx_unique").on(
      table.clientId,
      table.clientTxId
    ),
  })
);

export const syncGroupMemberships = pgTable(
  "sync_group_memberships",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    groupId: text("group_id").notNull(),
    groupType: text("group_type").notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
  },
  (table) => ({
    userGroupUnique: uniqueIndex("sync_group_memberships_user_group_unique").on(
      table.userId,
      table.groupId
    ),
  })
);
```

Adapt the model table columns to match whatever fields the user chose. `syncActions` and `syncGroupMemberships` are always identical.

---

## Config

`server/src/config.ts`

```ts
export const DEV_GROUP_ID = "dev-group";
export const DEV_TOKEN = "dev-token";
export const DEV_USER_ID = "dev-user";
```

---

## Server entry

`server/src/server.ts`

```ts
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
import { syncActions, syncGroupMemberships, {{MODEL_TABLE}} } from "./db/schema.js";

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

const {{MODEL_NAME_LOWER}}Config: SyncModelConfig = {
  bootstrap: {
    buildScopeWhere: (filter, _db) =>
      filter.workspaceGroupIds.length > 0
        ? inArray({{MODEL_TABLE}}.groupId, filter.workspaceGroupIds)
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
  table: {{MODEL_TABLE}},
};

const sync = await createSyncServer({
  auth: {
    resolveGroups: (userId) => syncDao.getUserGroups(userId),
    verifyToken: (token) =>
      Promise.resolve(token === DEV_TOKEN ? { userId: DEV_USER_ID } : null),
  },
  db,
  models: {
    {{MODEL_NAME}}: {{MODEL_NAME_LOWER}}Config,
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
  port: {{API_PORT}},
});

fastify.log.info({ address }, "{{PROJECT_NAME}} sync API listening");
```

Adapt `bootstrap.fields`, `bootstrap.instantFields`, `mutate.insertFields`, and `mutate.updateFields` to match the user's model fields.
