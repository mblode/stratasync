import { getTableColumns } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";

import type { SerializedSyncActionOutput, SyncActionOutput } from "../types.js";

const NON_NEGATIVE_INTEGER_REGEX = /^\d+$/;

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

interface RawSyncAction {
  id: bigint;
  model: string;
  modelId: string;
  action: string;
  data: unknown;
  groupId: string | null;
  clientTxId: string | null;
  clientId: string | null;
  createdAt: Date;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const serializeSyncId = (syncId: bigint): string => syncId.toString();

export const parseSyncIdString = (syncId: string): bigint => {
  if (!NON_NEGATIVE_INTEGER_REGEX.test(syncId)) {
    throw new Error(`Invalid syncId: ${syncId}`);
  }
  return BigInt(syncId);
};

/**
 * Converts a raw database sync action to the output format.
 */
export const toSyncActionOutput = (
  action: RawSyncAction
): SyncActionOutput => ({
  action: action.action,
  clientId: action.clientId ?? undefined,
  clientTxId: action.clientTxId ?? undefined,
  createdAt: action.createdAt,
  data: (action.data as Record<string, unknown>) ?? {},
  groupId: action.groupId ?? undefined,
  modelId: action.modelId,
  modelName: action.model,
  syncId: serializeSyncId(action.id),
});

export const serializeSyncActionOutput = (
  action: SyncActionOutput
): SerializedSyncActionOutput => ({
  action: action.action,
  clientId: action.clientId,
  clientTxId: action.clientTxId,
  createdAt: action.createdAt.toISOString(),
  data: action.data,
  groupId: action.groupId,
  modelId: action.modelId,
  modelName: action.modelName,
  syncId: action.syncId,
});

export const parseSyncActionOutput = (raw: unknown): SyncActionOutput => {
  if (!isRecord(raw)) {
    throw new Error("Sync action must be an object");
  }

  const { action, createdAt, data, modelId, modelName, syncId } = raw;

  if (typeof action !== "string") {
    throw new TypeError("Sync action action must be a string");
  }
  if (typeof createdAt !== "string") {
    throw new TypeError("Sync action createdAt must be a string");
  }
  if (!isRecord(data)) {
    throw new Error("Sync action data must be an object");
  }
  if (typeof modelId !== "string") {
    throw new TypeError("Sync action modelId must be a string");
  }
  if (typeof modelName !== "string") {
    throw new TypeError("Sync action modelName must be a string");
  }
  if (typeof syncId !== "string") {
    throw new TypeError("Sync action syncId must be a string");
  }

  parseSyncIdString(syncId);

  const createdAtDate = new Date(createdAt);
  if (Number.isNaN(createdAtDate.getTime())) {
    throw new TypeError("Sync action createdAt must be a valid date");
  }

  const parsed: SyncActionOutput = {
    action,
    createdAt: createdAtDate,
    data,
    modelId,
    modelName,
    syncId,
  };

  if (typeof raw.groupId === "string") {
    parsed.groupId = raw.groupId;
  }
  if (typeof raw.clientTxId === "string") {
    parsed.clientTxId = raw.clientTxId;
  }
  if (typeof raw.clientId === "string") {
    parsed.clientId = raw.clientId;
  }

  return parsed;
};
