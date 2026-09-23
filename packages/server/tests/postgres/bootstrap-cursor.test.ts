import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { integer, pgSchema, varchar } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { streamModel } from "../../src/bootstrap/cursor.js";
import type { SyncDb } from "../../src/db.js";

describe.skipIf(!process.env.STRATASYNC_TEST_DATABASE_URL)(
  "PostgreSQL composite keyset bootstrap",
  () => {
    const url = process.env.STRATASYNC_TEST_DATABASE_URL ?? "";
    const schemaName = `cursor_test_${randomUUID().replaceAll("-", "")}`;
    const schema = pgSchema(schemaName);
    const items = schema.table("items", {
      id: varchar({ length: 16 }).notNull(),
      listId: varchar("list_id", { length: 16 }).notNull(),
      sortOrder: integer("sort_order"),
    });
    let client: ReturnType<typeof postgres>;

    beforeAll(async () => {
      if (
        !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)
      ) {
        throw new Error("The cursor fixture only accepts a local database");
      }
      client = postgres(url, {
        max: 2,
        onnotice: () => {
          // Suppress expected schema-drop notices.
        },
      });
      await client.unsafe(`CREATE SCHEMA "${schemaName}"`);
      await client.unsafe(`CREATE TABLE "${schemaName}".items (
        id varchar(16) PRIMARY KEY, list_id varchar(16) NOT NULL, sort_order integer
      )`);
    });

    afterAll(async () => {
      await client?.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await client?.end();
    });

    it("does not skip a row with a NULL non-first cursor field at a page boundary", async () => {
      // Page 1 (1000 rows) ends on (list-a, 999); the next key is
      // (list-a, NULL), which sorts NULLS LAST inside list-a.
      await client.unsafe(`INSERT INTO "${schemaName}".items (id, list_id, sort_order)
        SELECT 'a' || lpad(g::text, 4, '0'), 'list-a', g FROM generate_series(0, 999) g`);
      await client.unsafe(`INSERT INTO "${schemaName}".items (id, list_id, sort_order)
        VALUES ('a-null', 'list-a', NULL), ('b0', 'list-b', 0), ('b-null', 'list-b', NULL)`);

      const db = drizzle({ client }) as unknown as SyncDb;
      const ids: unknown[] = [];
      for await (const row of streamModel(
        db,
        items,
        sql`true`,
        { fields: ["id"] },
        {
          fields: ["listId", "sortOrder", "id"],
          syntheticId: (item) => String(item.id),
          type: "composite",
        }
      )) {
        ids.push(row.id);
      }

      expect(ids).toHaveLength(1003);
      expect(new Set(ids).size).toBe(1003);
      expect(ids.slice(999)).toEqual(["a0999", "a-null", "b0", "b-null"]);
    });
  }
);
