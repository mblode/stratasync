// oxlint-disable no-use-before-define -- helper functions are grouped after exported generators for readability
import type {
  BatchLoadOptions,
  BatchRequest,
  BootstrapMetadata,
  BootstrapOptions,
  ModelRow,
} from "@stratasync/core";
import {
  finalizeBootstrapMetadata,
  parseBootstrapLine,
  readNdjsonLines,
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
