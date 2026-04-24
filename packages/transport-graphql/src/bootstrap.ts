// oxlint-disable no-use-before-define -- helper functions are grouped after exported generators for readability
import type {
  BatchLoadOptions,
  BatchRequest,
  BootstrapMetadata,
  BootstrapOptions,
  ModelRow,
} from "@stratasync/core";

import { joinSyncUrl, normalizeSyncEndpoint } from "./protocol.js";
import type { AuthProvider, RetryConfig } from "./types.js";
import {
  buildRequestHeaders,
  executeWithAuthRetry,
  fetchChecked,
  isRetryableError,
  parseSyncId,
  retryWithBackoff,
} from "./utils.js";

export interface BootstrapStreamOptions {
  syncEndpoint: string;
  bootstrapOptions: BootstrapOptions;
  auth: AuthProvider;
  headers?: Record<string, string>;
  retryConfig?: RetryConfig;
  timeoutMs?: number;
}

/**
 * Creates a bootstrap stream that yields model rows
 */
// oxlint-disable-next-line func-style, require-yields -- generators require function declaration
export async function* createBootstrapStream(
  opts: BootstrapStreamOptions
): AsyncGenerator<ModelRow, BootstrapMetadata, unknown> {
  const url = buildBootstrapUrl(opts.syncEndpoint, opts.bootstrapOptions);

  const response = await retryWithBackoff(
    () =>
      executeWithAuthRetry(opts.auth, (token) => {
        const requestHeaders = buildRequestHeaders({
          accept: "application/x-ndjson",
          headers: opts.headers,
          token,
        });
        return fetchChecked(
          url,
          { headers: requestHeaders, method: "GET" },
          opts.timeoutMs,
          "Bootstrap failed"
        );
      }),
    opts.retryConfig,
    isRetryableError
  );

  if (!response.body) {
    throw new Error("Bootstrap response has no body");
  }

  let metadata: BootstrapMetadata | null = null;

  for await (const line of readNdjsonLines(response.body, opts.timeoutMs)) {
    const parsed = parseBootstrapLine(line);

    if (parsed?.type === "meta") {
      ({ metadata } = parsed);
    } else if (parsed?.type === "row") {
      yield parsed.row;
    }
  }

  return finalizeBootstrapMetadata(metadata, opts.bootstrapOptions);
}

export interface BatchLoadStreamOptions {
  syncEndpoint: string;
  batchLoadOptions: BatchLoadOptions;
  auth: AuthProvider;
  headers?: Record<string, string>;
  retryConfig?: RetryConfig;
  timeoutMs?: number;
}

/**
 * Batch loads specific model instances via REST
 */
// oxlint-disable-next-line func-style, require-yields -- generators require function declaration
export async function* createBatchLoadStream(
  opts: BatchLoadStreamOptions
): AsyncGenerator<ModelRow, void, unknown> {
  const body = JSON.stringify({
    firstSyncId: parseSyncId(
      opts.batchLoadOptions.firstSyncId,
      "Batch load firstSyncId"
    ),
    requests: opts.batchLoadOptions.requests.map(serializeBatchRequest),
  });

  const syncBase = normalizeSyncEndpoint(opts.syncEndpoint);
  const url = joinSyncUrl(syncBase, "/batch");
  const response = await retryWithBackoff(
    () =>
      executeWithAuthRetry(opts.auth, (token) => {
        const requestHeaders = buildRequestHeaders({
          accept: "application/x-ndjson",
          contentType: "application/json",
          headers: opts.headers,
          token,
        });
        return fetchChecked(
          url,
          { body, headers: requestHeaders, method: "POST" },
          opts.timeoutMs,
          "Batch load failed"
        );
      }),
    opts.retryConfig,
    isRetryableError
  );

  if (!response.body) {
    throw new Error("Batch load response has no body");
  }

  for await (const line of readNdjsonLines(response.body, opts.timeoutMs)) {
    const parsed = parseBootstrapLine(line);
    if (parsed?.type === "row") {
      yield parsed.row;
    }
  }
}

const buildBootstrapUrl = (
  syncEndpoint: string,
  options: BootstrapOptions
): string => {
  const params = new URLSearchParams();
  params.set("type", options.type ?? "full");
  if (options.onlyModels?.length) {
    params.set("onlyModels", options.onlyModels.join(","));
  }
  if (options.schemaHash) {
    params.set("schemaHash", options.schemaHash);
  }
  if (options.firstSyncId !== undefined) {
    params.set(
      "firstSyncId",
      parseSyncId(options.firstSyncId, "Bootstrap options firstSyncId")
    );
  }
  if (options.syncGroups?.length) {
    params.set("syncGroups", options.syncGroups.join(","));
  }
  if (options.noSyncPackets) {
    params.set("noSyncPackets", "true");
  }
  if (options.useCFCaching) {
    params.set("useCFCaching", "true");
  }
  if (options.noCache) {
    params.set("noCache", "true");
  }
  if (options.modelsHash) {
    params.set("modelsHash", options.modelsHash);
  }

  const syncBase = normalizeSyncEndpoint(syncEndpoint);
  return `${joinSyncUrl(syncBase, "/bootstrap")}?${params.toString()}`;
};

// oxlint-disable-next-line func-style -- generators require function declaration
async function* readNdjsonLines(
  body: ReadableStream<Uint8Array>,
  timeoutMs?: number
): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await readChunkWithTimeout(reader, timeoutMs);

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          yield trimmed;
        }
      }
    }

    if (buffer.trim()) {
      yield buffer.trim();
    }
  } finally {
    reader.releaseLock();
  }
}

const readChunkWithTimeout = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs?: number
): Promise<ReadableStreamReadResult<Uint8Array>> => {
  if (timeoutMs === undefined) {
    return reader.read();
  }

  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      reader.read(),
      // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Stream read timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

const finalizeBootstrapMetadata = (
  metadata: BootstrapMetadata | null,
  options: BootstrapOptions
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

type ParsedBootstrapLine =
  | { type: "meta"; metadata: BootstrapMetadata }
  | { type: "row"; row: ModelRow };

const parseBootstrapLine = (line: string): ParsedBootstrapLine | null => {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("_metadata_=")) {
    const raw = JSON.parse(trimmed.slice("_metadata_=".length)) as Record<
      string,
      unknown
    >;
    return { metadata: normalizeBootstrapMetadata(raw), type: "meta" };
  }

  const parsed = JSON.parse(trimmed) as Record<string, unknown>;

  if (typeof parsed._metadata_ === "object" && parsed._metadata_ !== null) {
    return {
      metadata: normalizeBootstrapMetadata(
        parsed._metadata_ as Record<string, unknown>
      ),
      type: "meta",
    };
  }

  const modelName = resolveModelName(parsed);
  if (modelName) {
    const { __class, ...data } = parsed;
    return {
      row: { data, modelName },
      type: "row",
    };
  }

  if (isBootstrapMetadata(parsed)) {
    return { metadata: normalizeBootstrapMetadata(parsed), type: "meta" };
  }

  if (parsed.type === "error") {
    const message =
      typeof parsed.message === "string"
        ? parsed.message
        : "Unknown server error";
    throw new Error(`Bootstrap server error: ${message}`);
  }

  if (parsed.type === "end") {
    return null;
  }

  throw new Error("Bootstrap row is missing __class");
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
    subscribedSyncGroups,
  };

  if (lastSyncIdRaw !== undefined) {
    result.lastSyncId = parseSyncId(
      lastSyncIdRaw,
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

const resolveModelName = (parsed: Record<string, unknown>): string | null => {
  if (typeof parsed.__class === "string") {
    return parsed.__class;
  }
  return null;
};

const serializeBatchRequest = (
  request: BatchRequest
): Record<string, unknown> => {
  if ("indexedKey" in request && typeof request.indexedKey === "string") {
    return {
      indexedKey: request.indexedKey,
      keyValue: request.keyValue,
      modelName: request.modelName,
    };
  }

  return {
    groupId: request.groupId,
    modelName: request.modelName,
  };
};
