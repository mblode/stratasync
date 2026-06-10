import type { BootstrapMetadata, ModelRow, SyncId } from "@stratasync/core";
import { parseBootstrapLine, readNdjsonLines } from "@stratasync/core";

export interface BootstrapParseResult {
  rows: ModelRow[];
  metadata: BootstrapMetadata | null;
  rowCount?: number;
}

interface ValidatedBootstrapMetadata extends BootstrapMetadata {
  lastSyncId: SyncId;
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
