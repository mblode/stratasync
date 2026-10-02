import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const todos = pgTable("todos", {
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
    // Delta reads: one ordered range scan per subscribed group.
    groupIdIdx: index("sync_actions_group_id_id_idx").on(
      table.groupId,
      table.id
    ),
    // Bootstrap's "touched since" check by model row.
    modelIdx: index("sync_actions_model_model_id_idx").on(
      table.model,
      table.modelId
    ),
    // Delta reads of public (null-group) rows in id order, which
    // `(group_id, id)` cannot provide for `IS NULL`.
    publicIdIdx: index("sync_actions_public_id_idx")
      .on(table.id)
      .where(sql`${table.groupId} IS NULL`),
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
