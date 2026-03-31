import { getTableColumns } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";

import type { FieldSpec, FieldType } from "../mutate/field-codecs.js";

// ---------------------------------------------------------------------------
// Column type sets
// ---------------------------------------------------------------------------

const INSTANT_COLUMN_TYPES = new Set(["PgTimestamp", "PgTimestampString"]);

const DATE_ONLY_COLUMN_TYPES = new Set(["PgDate", "PgDateString"]);

const NUMBER_COLUMN_TYPES = new Set([
  "PgInteger",
  "PgSerial",
  "PgSmallInt",
  "PgBigInt53",
  "PgBigSerial",
  "PgDoublePrecision",
  "PgReal",
  "PgNumeric",
]);

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/**
 * Inferred bootstrap field lists, ready to spread into BootstrapModelConfig.
 *
 * `cursor` and `buildScopeWhere` are intentionally omitted — they require
 * application-specific knowledge that cannot be derived from column metadata.
 */
export interface InferredBootstrapFields {
  /** All column JS keys, for `BootstrapModelConfig.fields` */
  fields: string[];
  /**
   * Timestamp column JS keys, for `BootstrapModelConfig.instantFields`.
   * Omitted when the table has no timestamp columns.
   */
  instantFields?: string[];
  /**
   * Date-only column JS keys, for `BootstrapModelConfig.dateOnlyFields`.
   * Omitted when the table has no date-only columns.
   */
  dateOnlyFields?: string[];
}

/**
 * Inferred mutate field config, ready to spread into StandardMutateConfig.
 *
 * `updateFields` includes every non-primary-key column. Remove creation-only
 * fields (e.g. `createdAt`) yourself:
 * ```ts
 * fields.mutate.updateFields.delete("createdAt");
 * ```
 */
export interface InferredMutateFields {
  /** Field specs for all non-primary-key columns, for `StandardMutateConfig.insertFields` */
  insertFields: Record<string, FieldSpec>;
  /** All non-primary-key column names, for `StandardMutateConfig.updateFields` */
  updateFields: Set<string>;
}

/**
 * All inferred field metadata derived from a Drizzle table definition.
 */
export interface InferredTableFields {
  bootstrap: InferredBootstrapFields;
  mutate: InferredMutateFields;
}

// ---------------------------------------------------------------------------
// Inference helpers
// ---------------------------------------------------------------------------

const inferFieldType = (
  columnType: string,
  notNull: boolean,
  hasDefault: boolean
): FieldType => {
  if (INSTANT_COLUMN_TYPES.has(columnType)) {
    // Use "dateNow" for timestamps that have a DB default (e.g. createdAt DEFAULT now()).
    // The server will supply the current time when the client omits the value.
    return hasDefault ? "dateNow" : "date";
  }

  if (DATE_ONLY_COLUMN_TYPES.has(columnType)) {
    return "dateOnly";
  }

  if (NUMBER_COLUMN_TYPES.has(columnType)) {
    // There is no "numberNull" FieldType. For nullable numeric columns we fall
    // back to "stringNull" so that null passes through the default coercion
    // branch rather than being coerced to 0 via the "number" branch.
    return notNull ? "number" : "stringNull";
  }

  // Booleans and all other column types pass through coerceInsertValue's
  // default branch, so "string" / "stringNull" are safe sentinels here.
  return notNull ? "string" : "stringNull";
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Infers bootstrap field lists and mutate field specs from a Drizzle
 * `pgTable` definition.
 *
 * The returned objects are designed to spread directly into the corresponding
 * sections of `SyncModelConfig`:
 *
 * ```ts
 * import { inferTableFields } from "@stratasync/server";
 * import { tasksTable } from "./schema";
 *
 * const taskFields = inferTableFields(tasksTable);
 *
 * createSyncServer({
 *   models: {
 *     Task: {
 *       table: tasksTable,
 *       groupKey: "workspaceId",
 *       bootstrap: {
 *         ...taskFields.bootstrap,
 *         cursor: { type: "simple", idField: "id" },
 *         buildScopeWhere: (filter) =>
 *           inArray(tasksTable.workspaceId, filter.authorizedGroupIds),
 *       },
 *       mutate: {
 *         kind: "standard",
 *         actions: new Set(["I", "U", "D"]),
 *         ...taskFields.mutate,
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * Column → FieldType mapping:
 * - `PgTimestamp` / `PgTimestampString` with a default → `"dateNow"`
 * - `PgTimestamp` / `PgTimestampString` without a default → `"date"`
 * - `PgDate` / `PgDateString` → `"dateOnly"`
 * - Integer / serial / numeric types → `"number"`
 * - Everything else (text, boolean, uuid, …) → `"string"` (or `"stringNull"` if nullable)
 *
 * The primary key column is included in `bootstrap.fields` but excluded from
 * `mutate.insertFields` and `mutate.updateFields`.
 */
export const inferTableFields = (table: AnyPgTable): InferredTableFields => {
  const columns = getTableColumns(table);

  const bootstrapFields: string[] = [];
  const instantFields: string[] = [];
  const dateOnlyFields: string[] = [];
  const insertFields: Record<string, FieldSpec> = {};
  const updateFields = new Set<string>();

  for (const [key, col] of Object.entries(columns)) {
    bootstrapFields.push(key);

    if (col.primary) {
      // Primary key is tracked by the model runtime; omit from insert/update.
      continue;
    }

    if (INSTANT_COLUMN_TYPES.has(col.columnType)) {
      instantFields.push(key);
    } else if (DATE_ONLY_COLUMN_TYPES.has(col.columnType)) {
      dateOnlyFields.push(key);
    }

    insertFields[key] = {
      type: inferFieldType(col.columnType, col.notNull, col.hasDefault),
    };
    updateFields.add(key);
  }

  const bootstrap: InferredBootstrapFields = { fields: bootstrapFields };
  if (instantFields.length > 0) {
    bootstrap.instantFields = instantFields;
  }
  if (dateOnlyFields.length > 0) {
    bootstrap.dateOnlyFields = dateOnlyFields;
  }

  return { bootstrap, mutate: { insertFields, updateFields } };
};
