import type { SerializedSyncActionOutput, SyncActionOutput } from "../types.js";
import { isRecord } from "./guards.js";
import { parseSyncIdString, serializeSyncId } from "./sync-id.js";

/**
 * The single canonical shape of a raw sync_actions row as it comes back from
 * the DAO/drizzle. This replaces the four duplicate row shapes that previously
 * lived in sync-utils.ts, sync-dao.ts, mutate-service.ts, and the inline
 * `as unknown as {...}` casts in sync-websocket.ts and delta-service.ts.
 *
 * The one legitimate drizzle cast lives in the DAO, which returns rows typed as
 * `RawSyncActionRow`; everything downstream consumes this type directly.
 */
export interface RawSyncActionRow {
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

/**
 * Converts a raw database sync action row to the output format.
 */
export const toSyncActionOutput = (
  action: RawSyncActionRow
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
