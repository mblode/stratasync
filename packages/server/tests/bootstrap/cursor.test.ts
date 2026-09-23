import { sql } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";

import {
  createCursorStrategy,
  streamModel,
} from "../../src/bootstrap/cursor.js";
import type { SyncDb } from "../../src/db.js";

const items = pgTable("items", {
  id: text("id").primaryKey(),
  listId: text("list_id").notNull(),
  sortOrder: integer("sort_order"),
});

const cursorConfig = {
  fields: ["listId", "sortOrder", "id"],
  syntheticId: (item: Record<string, unknown>) => String(item.id),
  type: "composite",
} as const;

/** A db double that serves scripted pages in order, ignoring the query. */
const createPagedDb = (pages: Record<string, unknown>[][]) => {
  const conditions: unknown[] = [];
  const db = {
    select() {
      return {
        from() {
          return {
            where(condition: unknown) {
              conditions.push(condition);
              return {
                orderBy() {
                  return {
                    limit() {
                      return Promise.resolve(pages.shift() ?? []);
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SyncDb;
  return { conditions, db };
};

describe("composite keyset cursor", () => {
  it("keeps paging when the boundary row has a NULL cursor field", async () => {
    const firstPage = Array.from({ length: 1000 }, (_unused, index) => ({
      id: `item-${String(index).padStart(4, "0")}`,
      listId: "list-1",
      // The last row of the full page sorts NULLS LAST within its list.
      sortOrder: index === 999 ? null : index,
    }));
    const { db } = createPagedDb([
      firstPage,
      [{ id: "item-1000", listId: "list-2", sortOrder: 0 }],
    ]);

    const ids: unknown[] = [];
    for await (const row of streamModel(
      db,
      items,
      sql`true`,
      { fields: ["id", "listId", "sortOrder"] },
      cursorConfig
    )) {
      ids.push(row.id);
    }

    expect(ids).toHaveLength(1001);
    expect(ids.at(-1)).toBe("item-1000");
  });

  it("matches no row after an all-NULL cursor instead of restarting", () => {
    const strategy = createCursorStrategy({
      fields: ["listId", "sortOrder"],
      syntheticId: () => "",
      type: "composite",
    });

    expect(
      strategy.whereCondition(items, { listId: null, sortOrder: null })
    ).toBeDefined();
  });
});
