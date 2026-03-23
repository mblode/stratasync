import type { AnyPgTable } from "drizzle-orm/pg-core";

/**
 * Minimal Drizzle database interface used by sync-server internals.
 *
 * This covers the subset of Drizzle's query builder API that sync-server
 * actually calls. Keeping this explicit (instead of depending on Drizzle's
 * full type) means the package stays DB-agnostic and avoids type duplication
 * issues across workspace node_modules.
 */
export interface SyncDb {
  transaction<T>(callback: (tx: SyncDb) => Promise<T>): Promise<T>;
  select(fields?: Record<string, unknown>): SyncDbSelectBuilder;
  insert(table: AnyPgTable): {
    values(data: Record<string, unknown>): {
      returning(): Promise<Record<string, unknown>[]>;
    };
  };
  delete(table: AnyPgTable): {
    where(condition: unknown): Promise<unknown>;
  };
  update(table: AnyPgTable): {
    set(data: unknown): {
      where(condition: unknown): Promise<unknown>;
    };
  };
}

export interface SyncDbWhereResult {
  orderBy(...args: unknown[]): {
    limit(n: number): Promise<Record<string, unknown>[]>;
  };
  limit(n: number): Promise<Record<string, unknown>[]>;
}

export interface SyncDbSelectBuilder {
  from(table: AnyPgTable): {
    where(condition?: unknown): SyncDbWhereResult;
  };
}
