import { safeJsonStringify } from "../core/json.js";
import type { SyncActionOutput } from "../types.js";

const NON_NEGATIVE_INTEGER_REGEX = /^\d+$/;

export interface SubscribeMessage {
  type: "subscribe";
  afterSyncId: string;
  token: string;
  groups?: string[];
}

const isNonNegativeIntegerString = (value: string): boolean =>
  NON_NEGATIVE_INTEGER_REGEX.test(value);

export const isSubscribeMessage = (msg: unknown): msg is SubscribeMessage => {
  if (typeof msg !== "object" || msg === null) {
    return false;
  }
  const record = msg as Record<string, unknown>;
  if (record.type !== "subscribe") {
    return false;
  }
  if (typeof record.token !== "string") {
    return false;
  }
  const { afterSyncId } = record;
  const { groups } = record;
  const groupsValid =
    groups === undefined ||
    (Array.isArray(groups) &&
      groups.every((group) => typeof group === "string"));
  if (!groupsValid) {
    return false;
  }
  return (
    afterSyncId === undefined ||
    (typeof afterSyncId === "string" && isNonNegativeIntegerString(afterSyncId))
  );
};

// ---------------------------------------------------------------------------
// Frame builders — these lock the on-the-wire JSON key order in ONE place.
// ---------------------------------------------------------------------------

/**
 * Single-action delta frame. The action key order
 * {action, clientId, clientTxId, createdAt, data, groupId, modelId, modelName,
 * syncId} and the {packet:{actions,lastSyncId}, type} envelope are wire-locked.
 */
export const buildDeltaFrame = (
  action: SyncActionOutput,
  syncId: string
): string =>
  safeJsonStringify({
    packet: {
      actions: [
        {
          action: action.action,
          clientId: action.clientId,
          clientTxId: action.clientTxId,
          createdAt: action.createdAt.toISOString(),
          data: action.data,
          groupId: action.groupId,
          modelId: action.modelId,
          modelName: action.modelName,
          syncId,
        },
      ],
      lastSyncId: syncId,
    },
    type: "delta",
  });

/**
 * Error frame. `code` is omitted entirely when absent (preserves the historical
 * shape for both coded and uncoded errors).
 */
export const buildErrorFrame = (message: string, code?: string): string =>
  JSON.stringify({
    ...(code ? { code } : {}),
    message,
    type: "error",
  });

/**
 * `subscribed` acknowledgement, sent LAST after replay + buffered flush.
 */
export const buildSubscribedFrame = (
  afterSyncId: string,
  groups: string[]
): string =>
  JSON.stringify({
    afterSyncId,
    groups,
    type: "subscribed",
  });
