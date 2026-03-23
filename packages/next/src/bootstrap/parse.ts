// oxlint-disable no-use-before-define -- helper functions are grouped after exported functions for readability
import type { BootstrapMetadata, ModelRow, SyncId } from "@stratasync/core";

export interface BootstrapParseResult {
  rows: ModelRow[];
  metadata: BootstrapMetadata | null;
  rowCount?: number;
}

interface ValidatedBootstrapMetadata extends BootstrapMetadata {
  lastSyncId: SyncId;
}

type ParsedBootstrapLine =
  | { type: "meta"; metadata: BootstrapMetadata }
  | { type: "row"; row: ModelRow }
  | { type: "end"; rowCount?: number };

// oxlint-disable-next-line func-style -- generators require function declaration
async function* readNdjsonLines(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        yield line;
      }
    }

    const trimmed = buffer.trim();
    if (trimmed) {
      yield trimmed;
    }
  } finally {
    reader.releaseLock();
  }
}

export const readBootstrapStream = async (
  stream: ReadableStream<Uint8Array>
): Promise<BootstrapParseResult> => {
  const rows: ModelRow[] = [];
  let metadata: BootstrapMetadata | null = null;
  let rowCount: number | undefined;

  for await (const line of readNdjsonLines(stream)) {
    const parsed = parseBootstrapLine(line);
    if (!parsed) {
      continue;
    }

    if (parsed.type === "meta") {
      ({ metadata } = parsed);
    } else if (parsed.type === "row") {
      rows.push(parsed.row);
    } else {
      ({ rowCount } = parsed);
    }
  }

  return { metadata, rowCount, rows };
};

const parseBootstrapLine = (line: string): ParsedBootstrapLine | null => {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("_metadata_=")) {
    const raw = parseBootstrapJsonLine(
      trimmed.slice("_metadata_=".length)
    ) as Record<string, unknown>;
    return { metadata: normalizeBootstrapMetadata(raw), type: "meta" };
  }

  const parsed = parseBootstrapJsonLine(trimmed) as Record<string, unknown>;

  if (typeof parsed.__class === "string") {
    const { __class: modelName, ...data } = parsed;
    return {
      row: { data, modelName },
      type: "row",
    };
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

  if (isBootstrapMetadata(parsed)) {
    return { metadata: normalizeBootstrapMetadata(parsed), type: "meta" };
  }

  if (parsed.type === "end") {
    return {
      rowCount:
        typeof parsed.rowCount === "number" ? parsed.rowCount : undefined,
      type: "end",
    };
  }

  throw new TypeError("Bootstrap row is missing __class");
};

const parseBootstrapJsonLine = (line: string): unknown => {
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

const normalizeBootstrapMetadata = (
  parsed: Record<string, unknown>
): BootstrapMetadata => {
  const lastSyncIdRaw = parsed.lastSyncId;
  const subscribedSyncGroupsRaw = parsed.subscribedSyncGroups;

  const subscribedSyncGroups = Array.isArray(subscribedSyncGroupsRaw)
    ? subscribedSyncGroupsRaw.filter(
        (group): group is string => typeof group === "string"
      )
    : [];

  const result: BootstrapMetadata = {
    databaseVersion:
      typeof parsed.databaseVersion === "number"
        ? parsed.databaseVersion
        : undefined,
    raw: parsed,
    returnedModelsCount:
      parsed.returnedModelsCount &&
      typeof parsed.returnedModelsCount === "object"
        ? (parsed.returnedModelsCount as Record<string, number>)
        : undefined,
    schemaHash:
      typeof parsed.schemaHash === "string" ? parsed.schemaHash : undefined,
    subscribedSyncGroups,
  };

  if (typeof lastSyncIdRaw === "string" || typeof lastSyncIdRaw === "number") {
    result.lastSyncId = String(lastSyncIdRaw);
  }

  return result;
};

export const ensureBootstrapMetadata = (
  metadata: BootstrapMetadata | null
): ValidatedBootstrapMetadata => {
  if (!metadata) {
    throw new Error("Bootstrap prefetch did not receive metadata");
  }
  if (metadata.lastSyncId === undefined) {
    throw new Error("Bootstrap metadata is missing lastSyncId");
  }
  return { ...metadata, lastSyncId: metadata.lastSyncId };
};

export const resolveFirstSyncId = (
  metadata: ValidatedBootstrapMetadata
): SyncId => {
  const rawFirstSyncId = metadata.raw?.firstSyncId;
  if (
    typeof rawFirstSyncId === "string" ||
    typeof rawFirstSyncId === "number"
  ) {
    return String(rawFirstSyncId);
  }
  return metadata.lastSyncId;
};
