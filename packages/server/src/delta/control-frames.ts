/**
 * Server-initiated control frames.
 *
 * Deltas are cursor-based: a user newly added to a group has no prior actions
 * for it and that group's history sits *before* their cursor, so a delta fetch
 * would deliver nothing. Leaving is worse — the rows simply stop updating and
 * linger in the local cache.
 *
 * These frames close both gaps for live sessions. They are addressed to one
 * user, and a no-op when that user has no socket open: bootstrap already
 * filters on current membership, so the next bootstrap is correct regardless.
 * That property is what keeps them safe — they are an optimisation for live
 * sessions, never the source of truth. A client that ignores them still
 * converges, just on reconnect rather than live.
 */
export type ControlFrameType = "group_joined" | "group_left";

export interface ControlFrame {
  type: ControlFrameType;
  userId: string;
  groupId: string;
}

const CONTROL_FRAME_TYPES = new Set<string>([
  "group_joined",
  "group_left",
] satisfies ControlFrameType[]);

export const isControlFrameType = (value: unknown): value is ControlFrameType =>
  typeof value === "string" && CONTROL_FRAME_TYPES.has(value);

export const parseControlFrame = (raw: unknown): ControlFrame => {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Control frame must be an object");
  }

  const record = raw as Record<string, unknown>;

  if (!isControlFrameType(record.type)) {
    throw new Error("Control frame has an unknown type");
  }
  if (typeof record.userId !== "string" || record.userId.length === 0) {
    throw new Error("Control frame userId must be a non-empty string");
  }
  if (typeof record.groupId !== "string" || record.groupId.length === 0) {
    throw new Error("Control frame groupId must be a non-empty string");
  }

  return {
    groupId: record.groupId,
    type: record.type,
    userId: record.userId,
  };
};
