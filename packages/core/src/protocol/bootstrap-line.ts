import { parseSyncId } from "../sync/sync-id.js";
import type { BootstrapMetadata, ModelRow } from "../sync/types.js";

const METADATA_PREFIX = "_metadata_=";

/**
 * A single parsed NDJSON line from a bootstrap or batch-load stream. Lines are
 * either model rows, the metadata record, or the terminal `end` marker.
 */
export type ParsedBootstrapLine =
  | { type: "meta"; metadata: BootstrapMetadata }
  | { type: "row"; row: ModelRow }
  | { type: "end"; rowCount?: number };

const parseJsonLine = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse bootstrap line: ${reason}`, {
      cause: error,
    });
  }
};

const isBootstrapMetadata = (parsed: Record<string, unknown>): boolean =>
  "lastSyncId" in parsed ||
  "subscribedSyncGroups" in parsed ||
  "returnedModelsCount" in parsed;

/**
 * Normalizes a raw metadata record into a BootstrapMetadata. The full record is
 * preserved on `raw` so callers can read server-specific extras (e.g.
 * `firstSyncId`).
 */
export const normalizeBootstrapMetadata = (
  parsed: Record<string, unknown>
): BootstrapMetadata => {
  const subscribedSyncGroupsRaw = parsed.subscribedSyncGroups;
  const subscribedSyncGroups = Array.isArray(subscribedSyncGroupsRaw)
    ? subscribedSyncGroupsRaw.filter(
        (group): group is string => typeof group === "string"
      )
    : [];

  const result: BootstrapMetadata = { subscribedSyncGroups };

  if (parsed.lastSyncId !== undefined) {
    result.lastSyncId = parseSyncId(
      parsed.lastSyncId,
      "Bootstrap metadata lastSyncId"
    );
  }
  if (
    parsed.returnedModelsCount &&
    typeof parsed.returnedModelsCount === "object"
  ) {
    result.returnedModelsCount = parsed.returnedModelsCount as Record<
      string,
      number
    >;
  }
  if (typeof parsed.schemaHash === "string") {
    result.schemaHash = parsed.schemaHash;
  }
  if (typeof parsed.databaseVersion === "number") {
    result.databaseVersion = parsed.databaseVersion;
  }
  result.raw = parsed;

  return result;
};

/**
 * Parses a single NDJSON bootstrap line. Returns null for blank lines and the
 * `end` marker carries an optional `rowCount`. Throws on a server error line or
 * a row that is neither metadata nor a `__class`-tagged model row.
 */
export const parseBootstrapLine = (
  line: string
): ParsedBootstrapLine | null => {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith(METADATA_PREFIX)) {
    const raw = parseJsonLine(trimmed.slice(METADATA_PREFIX.length)) as Record<
      string,
      unknown
    >;
    return { metadata: normalizeBootstrapMetadata(raw), type: "meta" };
  }

  const parsed = parseJsonLine(trimmed) as Record<string, unknown>;

  if (typeof parsed.__class === "string") {
    const { __class: modelName, ...data } = parsed;
    return { row: { data, modelName }, type: "row" };
  }

  if (typeof parsed._metadata_ === "object" && parsed._metadata_ !== null) {
    return {
      metadata: normalizeBootstrapMetadata(
        parsed._metadata_ as Record<string, unknown>
      ),
      type: "meta",
    };
  }

  if (parsed.type === "error") {
    const message =
      typeof parsed.message === "string"
        ? parsed.message
        : "Unknown server error";
    throw new Error(`Bootstrap server error: ${message}`);
  }

  // Checked before the metadata heuristic: an `end` line may carry a
  // `lastSyncId`, which would otherwise be misparsed as bootstrap metadata.
  if (parsed.type === "end") {
    return {
      rowCount:
        typeof parsed.rowCount === "number" ? parsed.rowCount : undefined,
      type: "end",
    };
  }

  if (isBootstrapMetadata(parsed)) {
    return { metadata: normalizeBootstrapMetadata(parsed), type: "meta" };
  }

  throw new Error("Bootstrap row is missing __class");
};

/**
 * Validates the metadata collected from a full bootstrap stream. Partial
 * bootstraps may legitimately omit metadata/lastSyncId.
 */
export const finalizeBootstrapMetadata = (
  metadata: BootstrapMetadata | null,
  options: { type?: string }
): BootstrapMetadata => {
  if (!metadata) {
    if (options.type === "partial") {
      return { subscribedSyncGroups: [] };
    }
    throw new Error("Bootstrap did not receive metadata");
  }

  if (options.type !== "partial" && metadata.lastSyncId === undefined) {
    throw new Error("Bootstrap metadata is missing lastSyncId");
  }

  return metadata;
};
