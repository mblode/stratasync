import { randomUUID } from "node:crypto";

import {
  bigserial,
  char,
  jsonb,
  pgSchema,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { SyncDao } from "../../src/dao/sync-dao.js";
import { DeltaService } from "../../src/delta/delta-service.js";

export const group = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

/** Every run owns a fresh schema. Never uses or truncates application tables. */
export const createFixture = async () => {
  const url = process.env.STRATASYNC_TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "Set STRATASYNC_TEST_DATABASE_URL to an isolated local PostgreSQL database"
    );
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
    throw new Error("The delta fixture only accepts a local database");
  }
  const client = postgres(url, {
    max: 4,
    onnotice: () => {
      // Suppress expected schema-drop notices.
    },
  });
  const schemaName = `delta_test_${randomUUID().replaceAll("-", "")}`;
  const schema = pgSchema(schemaName);
  const actions = schema.table("sync_actions", {
    action: char({ length: 1 }).notNull(),
    clientId: varchar("client_id", { length: 255 }),
    clientTxId: uuid("client_tx_id"),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    data: jsonb().notNull(),
    groupId: uuid("group_id"),
    id: bigserial({ mode: "bigint" }).primaryKey(),
    model: varchar({ length: 100 }).notNull(),
    modelId: uuid("model_id").notNull(),
  });
  const memberships = schema.table("sync_group_memberships", {
    groupId: uuid("group_id"),
    id: uuid(),
    userId: uuid("user_id"),
  });
  let lastQuery = { params: [] as unknown[], sql: "" };
  const db = drizzle({
    client,
    logger: {
      logQuery(query, params) {
        lastQuery = { params, sql: query };
      },
    },
  });
  const dao = new SyncDao(db, {
    syncActions: actions,
    syncGroupMemberships: memberships,
  });
  try {
    await client.unsafe(`CREATE SCHEMA "${schemaName}"`);
    await client.unsafe(`CREATE TABLE "${schemaName}".sync_actions (
      id bigserial PRIMARY KEY, model varchar(100) NOT NULL, model_id uuid NOT NULL,
      action char(1) NOT NULL, data jsonb NOT NULL, group_id uuid,
      client_id varchar(255), client_tx_id uuid, created_at timestamptz(3) NOT NULL DEFAULT now()
    )`);
    // Done Bear's relevant read indexes, including the separate group index.
    await client.unsafe(
      `CREATE INDEX ON "${schemaName}".sync_actions (group_id, id)`
    );
    await client.unsafe(
      `CREATE INDEX ON "${schemaName}".sync_actions (group_id)`
    );
    await client.unsafe(
      `CREATE INDEX ON "${schemaName}".sync_actions (created_at)`
    );
    await client.unsafe(
      `CREATE INDEX ON "${schemaName}".sync_actions (model, model_id)`
    );
  } catch (error) {
    await client.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await client.end();
    throw error;
  }
  return {
    actions,
    client,
    async close() {
      try {
        await client.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
      } finally {
        await client.end();
      }
    },
    dao,
    db,
    query: () => lastQuery,
    schemaName,
    service: new DeltaService(dao),
  };
};
