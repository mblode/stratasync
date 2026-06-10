import { getTableColumns } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";

// Re-export the canonical sync-id and sync-action helpers from core. These
// names are part of the package's public surface (donebear imports them) and
// must stay stable.
export { parseSyncIdString, serializeSyncId } from "../core/sync-id.js";
export {
  parseSyncActionOutput,
  serializeSyncActionOutput,
  toSyncActionOutput,
} from "../core/sync-action.js";

/**
 * Gets a typed column reference from a Drizzle table by column name.
 */
export const getColumn = (
  table: AnyPgTable,
  columnName: string
): AnyPgColumn => {
  const columnMap = getTableColumns(table) as Record<
    string,
    AnyPgColumn | undefined
  >;
  const column = columnMap[columnName];
  if (!column) {
    throw new Error(`Column ${columnName} not found on table ${table._.name}`);
  }
  return column;
};
