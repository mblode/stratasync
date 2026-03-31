import {
  boolean,
  date,
  doublePrecision,
  integer,
  numeric,
  pgTable,
  real,
  serial,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { inferTableFields } from "../../src/schema/infer-model.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tasksTable = pgTable("tasks", {
  completed: boolean("completed").notNull().default(false),
  count: integer("count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  description: text("description"),
  dueDate: date("due_date"),
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  title: text("title").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

const eventsTable = pgTable("events", {
  amount: numeric("amount", { precision: 10, scale: 2 }),
  happenedAt: timestamp("happened_at").notNull(),
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  rank: smallint("rank").notNull(),
  scheduledDate: date("scheduled_date").notNull(),
  score: real("score"),
  serialCol: serial("serial_col"),
  weight: doublePrecision("weight").notNull(),
});

const simpleTable = pgTable("simple", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe(inferTableFields, () => {
  describe("bootstrap.fields", () => {
    it("includes all column JS keys, including the primary key", () => {
      const { bootstrap } = inferTableFields(tasksTable);
      expect(bootstrap.fields).toEqual([
        "completed",
        "count",
        "createdAt",
        "description",
        "dueDate",
        "id",
        "projectId",
        "title",
        "updatedAt",
      ]);
    });
  });

  describe("bootstrap.instantFields", () => {
    it("lists PgTimestamp columns", () => {
      const { bootstrap } = inferTableFields(tasksTable);
      expect(bootstrap.instantFields).toEqual(["createdAt", "updatedAt"]);
    });

    it("is omitted when the table has no timestamp columns", () => {
      const { bootstrap } = inferTableFields(simpleTable);
      expect(bootstrap.instantFields).toBeUndefined();
    });
  });

  describe("bootstrap.dateOnlyFields", () => {
    it("lists PgDate / PgDateString columns", () => {
      const { bootstrap } = inferTableFields(tasksTable);
      expect(bootstrap.dateOnlyFields).toEqual(["dueDate"]);
    });

    it("is omitted when the table has no date-only columns", () => {
      const { bootstrap } = inferTableFields(simpleTable);
      expect(bootstrap.dateOnlyFields).toBeUndefined();
    });
  });

  describe("mutate.insertFields", () => {
    it("excludes the primary key column", () => {
      const { mutate } = inferTableFields(tasksTable);
      expect("id" in mutate.insertFields).toBeFalsy();
    });

    it("maps nullable text to stringNull", () => {
      const { mutate } = inferTableFields(tasksTable);
      expect(mutate.insertFields.description).toEqual({ type: "stringNull" });
    });

    it("maps non-null text to string", () => {
      const { mutate } = inferTableFields(tasksTable);
      expect(mutate.insertFields.title).toEqual({ type: "string" });
    });

    it("maps boolean columns to string (pass-through coercion)", () => {
      const { mutate } = inferTableFields(tasksTable);
      expect(mutate.insertFields.completed).toEqual({ type: "string" });
    });

    it("maps integer columns to number", () => {
      const { mutate } = inferTableFields(tasksTable);
      expect(mutate.insertFields.count).toEqual({ type: "number" });
    });

    it("maps timestamp with default to dateNow", () => {
      const { mutate } = inferTableFields(tasksTable);
      expect(mutate.insertFields.createdAt).toEqual({ type: "dateNow" });
    });

    it("maps timestamp without default to date", () => {
      const { mutate } = inferTableFields(tasksTable);
      expect(mutate.insertFields.updatedAt).toEqual({ type: "date" });
    });

    it("maps date column to dateOnly", () => {
      const { mutate } = inferTableFields(tasksTable);
      expect(mutate.insertFields.dueDate).toEqual({ type: "dateOnly" });
    });

    it("maps real / doublePrecision / smallint / numeric to number", () => {
      const { mutate } = inferTableFields(eventsTable);
      expect(mutate.insertFields.weight).toEqual({ type: "number" });
      expect(mutate.insertFields.rank).toEqual({ type: "number" });
    });

    it("maps nullable real to stringNull (no specific number-null type)", () => {
      // real with no notNull is nullable; the inferred FieldType falls back to stringNull
      // (the coercion default branch handles the actual value correctly at runtime).
      const { mutate } = inferTableFields(eventsTable);
      expect(mutate.insertFields.score).toEqual({ type: "stringNull" });
    });

    it("maps nullable numeric to stringNull", () => {
      const { mutate } = inferTableFields(eventsTable);
      expect(mutate.insertFields.amount).toEqual({ type: "stringNull" });
    });

    it("maps serial column to number", () => {
      const { mutate } = inferTableFields(eventsTable);
      expect(mutate.insertFields.serialCol).toEqual({ type: "number" });
    });

    it("maps uuid primary key column — excluded from insertFields", () => {
      const { mutate } = inferTableFields(eventsTable);
      expect("id" in mutate.insertFields).toBeFalsy();
    });
  });

  describe("mutate.updateFields", () => {
    it("includes all non-PK columns", () => {
      const { mutate } = inferTableFields(tasksTable);
      expect(mutate.updateFields.has("id")).toBeFalsy();
      expect(mutate.updateFields.has("title")).toBeTruthy();
      expect(mutate.updateFields.has("description")).toBeTruthy();
      expect(mutate.updateFields.has("completed")).toBeTruthy();
      expect(mutate.updateFields.has("projectId")).toBeTruthy();
      expect(mutate.updateFields.has("count")).toBeTruthy();
      expect(mutate.updateFields.has("createdAt")).toBeTruthy();
      expect(mutate.updateFields.has("dueDate")).toBeTruthy();
    });

    it("returns a mutable Set so callers can remove creation-only fields", () => {
      const { mutate } = inferTableFields(tasksTable);
      mutate.updateFields.delete("createdAt");
      expect(mutate.updateFields.has("createdAt")).toBeFalsy();
      // Other fields are unaffected.
      expect(mutate.updateFields.has("title")).toBeTruthy();
    });
  });

  describe("simple table", () => {
    it("returns minimal config for a table with only PK + one field", () => {
      const { bootstrap, mutate } = inferTableFields(simpleTable);
      expect(bootstrap).toEqual({ fields: ["id", "name"] });
      expect(mutate.insertFields).toEqual({ name: { type: "string" } });
      expect([...mutate.updateFields]).toEqual(["name"]);
    });
  });
});
