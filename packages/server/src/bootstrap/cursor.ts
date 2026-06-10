/* oxlint-disable max-classes-per-file */
import { and, asc, eq, gt, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";

import type { CursorConfig } from "../config.js";
import type { SyncDb } from "../db.js";
import { getColumn } from "../utils/sync-utils.js";
import { mapRow } from "./row-mapper.js";
import type { BootstrapFieldDef } from "./row-mapper.js";

const BATCH_SIZE = 1000;

const isCursorValue = (value: unknown): boolean =>
  value !== undefined && value !== null;

const combineAnd = (conditions: SQL<unknown>[]): SQL<unknown> | undefined => {
  const [first, ...rest] = conditions;
  if (!first) {
    return undefined;
  }
  if (rest.length === 0) {
    return first;
  }
  return and(first, ...rest);
};

const scopedWhere = (
  scope: SQL<unknown>,
  condition: SQL<unknown> | undefined
): SQL<unknown> => (condition ? (and(scope, condition) ?? scope) : scope);

/**
 * Abstracts the per-cursor-type SQL (ordering, the keyset WHERE condition, and
 * next-cursor extraction) so a single stream loop drives both simple and
 * composite cursors. `nextCursor` returning null stops paging.
 */
interface CursorStrategy {
  orderBy(table: AnyPgTable): SQL<unknown>[];
  whereCondition(table: AnyPgTable, cursor: unknown): SQL<unknown> | undefined;
  nextCursor(lastRow: Record<string, unknown>): unknown;
}

class SimpleCursorStrategy implements CursorStrategy {
  private readonly idField: string;

  constructor(idField: string) {
    this.idField = idField;
  }

  orderBy(table: AnyPgTable): SQL<unknown>[] {
    return [asc(getColumn(table, this.idField))];
  }

  whereCondition(table: AnyPgTable, cursor: unknown): SQL<unknown> | undefined {
    if (!isCursorValue(cursor)) {
      return undefined;
    }
    return gt(getColumn(table, this.idField), cursor);
  }

  nextCursor(lastRow: Record<string, unknown>): unknown {
    const value = lastRow[this.idField];
    return isCursorValue(value) ? value : null;
  }
}

class CompositeCursorStrategy implements CursorStrategy {
  private readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    this.fields = fields;
  }

  orderBy(table: AnyPgTable): SQL<unknown>[] {
    return this.fields.map((field) => asc(getColumn(table, field)));
  }

  whereCondition(table: AnyPgTable, cursor: unknown): SQL<unknown> | undefined {
    const cursorValues = cursor as Record<string, unknown> | undefined;
    if (!cursorValues || this.fields.length === 0) {
      return undefined;
    }

    // OR-of-ANDs keyset pagination: for each field i, (prefix equal) AND
    // (field i greater than cursor). Field 0 has no prefix.
    const orConditions: SQL<unknown>[] = [];
    for (let index = 0; index < this.fields.length; index += 1) {
      const branch = this.branch(table, cursorValues, index);
      if (branch) {
        orConditions.push(branch);
      }
    }

    return orConditions.length > 0 ? or(...orConditions) : undefined;
  }

  nextCursor(lastRow: Record<string, unknown>): unknown {
    const nextCursor: Record<string, unknown> = {};
    for (const field of this.fields) {
      const value = lastRow[field];
      // Stop-on-null-cursor-field: a null/undefined keyset field can't anchor
      // the next page deterministically, so paging must stop.
      if (!isCursorValue(value)) {
        return null;
      }
      nextCursor[field] = value;
    }
    return nextCursor;
  }

  private branch(
    table: AnyPgTable,
    cursorValues: Record<string, unknown>,
    index: number
  ): SQL<unknown> | undefined {
    const field = this.fields[index];
    if (!field) {
      return undefined;
    }

    const fieldValue = cursorValues[field];
    if (!isCursorValue(fieldValue)) {
      return undefined;
    }

    const currentGreaterThan = gt(getColumn(table, field), fieldValue);
    if (index === 0) {
      return currentGreaterThan;
    }

    const prefix = this.prefix(table, cursorValues, index);
    return prefix
      ? (and(prefix, currentGreaterThan) ?? currentGreaterThan)
      : currentGreaterThan;
  }

  private prefix(
    table: AnyPgTable,
    cursorValues: Record<string, unknown>,
    index: number
  ): SQL<unknown> | undefined {
    const prefixConditions: SQL<unknown>[] = [];
    for (let prefixIndex = 0; prefixIndex < index; prefixIndex += 1) {
      const prefixField = this.fields[prefixIndex];
      if (!prefixField) {
        continue;
      }
      const prefixValue = cursorValues[prefixField];
      if (!isCursorValue(prefixValue)) {
        continue;
      }
      prefixConditions.push(eq(getColumn(table, prefixField), prefixValue));
    }
    return combineAnd(prefixConditions);
  }
}

export const createCursorStrategy = (cursor: CursorConfig): CursorStrategy =>
  cursor.type === "simple"
    ? new SimpleCursorStrategy(cursor.idField)
    : new CompositeCursorStrategy(cursor.fields);

/**
 * Streams every scoped row of a model in keyset-paginated batches of 1000,
 * mapping each to the bootstrap wire shape. The cursor strategy decides
 * ordering, the keyset WHERE, and when to stop.
 */
// oxlint-disable-next-line func-style, require-yields
export async function* streamModel(
  db: SyncDb,
  table: AnyPgTable,
  scopeWhere: SQL<unknown>,
  fieldDef: BootstrapFieldDef,
  cursorConfig: CursorConfig
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  const strategy = createCursorStrategy(cursorConfig);
  const orderByColumns = strategy.orderBy(table);
  const [firstOrder, ...restOrder] = orderByColumns;
  if (!firstOrder) {
    return;
  }

  let cursor: unknown;
  while (true) {
    const where = scopedWhere(
      scopeWhere,
      strategy.whereCondition(table, cursor)
    );

    const rows = (await db
      .select()
      .from(table)
      .where(where)
      .orderBy(firstOrder, ...restOrder)
      .limit(BATCH_SIZE)) as Record<string, unknown>[];

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      yield mapRow(row, fieldDef, cursorConfig);
    }

    const last = rows.at(-1);
    if (!last || rows.length < BATCH_SIZE) {
      break;
    }

    const next = strategy.nextCursor(last);
    if (next === null) {
      break;
    }
    cursor = next;
  }
}
