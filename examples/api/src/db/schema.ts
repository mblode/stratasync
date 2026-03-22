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
