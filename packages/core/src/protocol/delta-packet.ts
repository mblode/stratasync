import { maxSyncId, parseSyncId, ZERO_SYNC_ID } from "../sync/sync-id.js";
import type { DeltaPacket, SyncAction, SyncActionType } from "../sync/types.js";

/**
 * Narrows a wire action letter to `SyncActionType`. The accepted set is the
 * eight documented on that type, not the five row-carrying ones — see its doc
 * comment for why `"C"`, `"G"` and `"S"` belong here.
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
 * Parses a raw sync action payload into a SyncAction.
 *
 * This is the **client-side** decoder: it reads server-authored bytes off the
 * wire, and its leniency is deliberate. A missing or null `data` becomes `{}`
 * and an unparseable `createdAt` is dropped rather than thrown on, because a
 * single odd field on one action must not tear down a sync session the user is
 * mid-edit in; the fields it does throw on (`syncId`, `modelName`, `modelId`,
 * `action`) are the ones without which the action cannot be routed at all.
 *
 * `parseSyncActionOutput` in `@stratasync/server` looks like a duplicate of
 * this and is not. It parses the server's *own* `serializeSyncActionOutput`
 * output back off the Redis delta channel, where a malformed message is a bug
 * in this codebase rather than a peer being generous — so it rejects all three
 * of the cases above. Conversely it does not validate the action letter, since
 * the server writes that letter itself.
 *
 * Keep the two asymmetric. Making this one strict turns a tolerable server
 * quirk into a broken client; making that one lenient lets a corrupt internal
 * message through silently. Both are pinned by
 * `corpus/vectors/parse-sync-action.json` and
 * `corpus/vectors/parse-sync-action-output.json`.
 */
export const parseSyncAction = (raw: Record<string, unknown>): SyncAction => {
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
    const parsedDate = new Date(createdAtRaw);
    if (!Number.isNaN(parsedDate.getTime())) {
      createdAt = parsedDate;
    }
  }

  const groupsRaw = raw.groups;
  const groups = Array.isArray(groupsRaw)
    ? groupsRaw.filter((group): group is string => typeof group === "string")
    : undefined;

  const groupId = typeof raw.groupId === "string" ? raw.groupId : undefined;
  const data =
    typeof raw.data === "object" &&
    raw.data !== null &&
    !Array.isArray(raw.data)
      ? (raw.data as Record<string, unknown>)
      : {};

  const result: SyncAction = {
    action: normalizeAction(actionRaw),
    data,
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
 * Parses a raw delta packet payload into a DeltaPacket. Accepts a bare array
 * of actions, a `{ type: "delta", packet }` envelope, a direct
 * `{ actions, lastSyncId }` object, or a single action object.
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
    const actions = payload.actions
      .filter(
        (action): action is Record<string, unknown> =>
          typeof action === "object" && action !== null
      )
      .map((action) => parseSyncAction(action));
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
