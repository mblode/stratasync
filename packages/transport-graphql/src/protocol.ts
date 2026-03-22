import type { DeltaPacket, SyncAction, SyncActionType } from "@stratasync/core";
import { maxSyncId, ZERO_SYNC_ID } from "@stratasync/core";

import { parseSyncId } from "./utils.js";

const SYNC_ENDPOINT_SUFFIXES = ["/bootstrap", "/batch", "/deltas"];
const TRAILING_SLASH_RE = /\/+$/;

/**
 * Normalizes a sync endpoint to its base path (e.g., /sync)
 */
export const normalizeSyncEndpoint = (endpoint: string): string => {
  const trimmed = endpoint.replace(TRAILING_SLASH_RE, "");
  for (const suffix of SYNC_ENDPOINT_SUFFIXES) {
    if (trimmed.endsWith(suffix)) {
      return trimmed.slice(0, -suffix.length);
    }
  }
  return trimmed;
};

/**
 * Joins a base URL with a path segment
 */
export const joinSyncUrl = (base: string, path: string): string => {
  const normalizedBase = base.replace(TRAILING_SLASH_RE, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
};

/**
 * Maps action strings to internal action codes
 */
const normalizeAction = (action: string): SyncActionType => {
  if (
    action === "I" ||
    action === "U" ||
    action === "D" ||
    action === "A" ||
    action === "V" ||
    action === "C" ||
    action === "G" ||
    action === "S"
  ) {
    return action;
  }
  throw new Error(`Unknown action: ${action}`);
};

/**
 * Parses a raw sync action payload into a SyncAction
 */
const parseSyncAction = (raw: Record<string, unknown>): SyncAction => {
  const syncIdRaw = raw.syncId ?? raw.id;
  if (syncIdRaw === undefined) {
    throw new TypeError("Sync action is missing syncId/id");
  }
  const parsedSyncId = parseSyncId(syncIdRaw, "Sync action syncId/id");

  const { modelName } = raw;
  if (typeof modelName !== "string") {
    throw new TypeError("Sync action is missing modelName");
  }

  const { modelId } = raw;
  if (typeof modelId !== "string") {
    throw new TypeError("Sync action is missing modelId");
  }

  const actionRaw = raw.action;
  if (typeof actionRaw !== "string") {
    throw new TypeError("Sync action is missing action");
  }

  const createdAtRaw = raw.createdAt;
  let createdAt: Date | undefined;
  if (typeof createdAtRaw === "string" || typeof createdAtRaw === "number") {
    createdAt = new Date(createdAtRaw);
  }

  const groupsRaw = raw.groups;
  const groups = Array.isArray(groupsRaw)
    ? groupsRaw.filter((group): group is string => typeof group === "string")
    : undefined;

  const groupId = typeof raw.groupId === "string" ? raw.groupId : undefined;

  const result: SyncAction = {
    action: normalizeAction(actionRaw),
    data: (raw.data as Record<string, unknown>) ?? {},
    id: parsedSyncId,
    modelId,
    modelName,
  };

  if (groupId !== undefined) {
    result.groupId = groupId;
  }
  if (groups !== undefined) {
    result.groups = groups;
  }
  if (typeof raw.clientTxId === "string") {
    result.clientTxId = raw.clientTxId;
  }
  if (typeof raw.clientId === "string") {
    result.clientId = raw.clientId;
  }
  if (createdAt !== undefined) {
    result.createdAt = createdAt;
  }

  return result;
};

/**
 * Parses a raw delta packet payload into a DeltaPacket
 */
export const parseDeltaPacket = (raw: unknown): DeltaPacket | null => {
  if (Array.isArray(raw)) {
    const actions = raw
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null
      )
      .map((item) => parseSyncAction(item));
    // oxlint-disable-next-line no-array-reduce
    const lastSyncId = actions.reduce(
      (max, action) => maxSyncId(max, action.id),
      ZERO_SYNC_ID
    );
    return { actions, lastSyncId };
  }

  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const payload = raw as Record<string, unknown>;

  if (
    payload.type === "delta" &&
    payload.packet &&
    typeof payload.packet === "object"
  ) {
    return parseDeltaPacket(payload.packet);
  }

  if (Array.isArray(payload.actions)) {
    const actions = payload.actions.map((action) =>
      parseSyncAction(action as Record<string, unknown>)
    );
    const lastSyncIdRaw = payload.lastSyncId;
    const lastSyncId =
      // oxlint-disable-next-line no-array-reduce
      lastSyncIdRaw === undefined
        ? // oxlint-disable-next-line no-array-reduce
          actions.reduce(
            (max, action) => maxSyncId(max, action.id),
            ZERO_SYNC_ID
          )
        : parseSyncId(lastSyncIdRaw, "Delta packet lastSyncId");

    const packet: DeltaPacket = {
      actions,
      lastSyncId,
    };
    if (typeof payload.hasMore === "boolean") {
      packet.hasMore = payload.hasMore;
    }
    return packet;
  }

  if (payload.action && payload.modelName && payload.modelId) {
    const action = parseSyncAction(payload);
    return {
      actions: [action],
      lastSyncId: action.id,
    };
  }

  return null;
};
