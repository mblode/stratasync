// oxlint-disable no-use-before-define -- helper functions are grouped after exported functions for readability
import {
  ensureBootstrapMetadata,
  readBootstrapStream,
  resolveFirstSyncId,
} from "./parse.js";
import type { BootstrapSnapshot, PrefetchBootstrapOptions } from "./types.js";

const DEFAULT_PREFETCH_TIMEOUT_MS = 10_000;
const NDJSON_ACCEPT_HEADER = "application/x-ndjson";
const TRAILING_SLASH_RE = /\/+$/;
const KNOWN_SYNC_SUFFIXES = ["/bootstrap", "/batch", "/deltas"];

const createBootstrapTimeoutError = function createBootstrapTimeoutError(
  timeout: number,
  cause?: unknown
): Error {
  return new Error(`Bootstrap prefetch timed out after ${timeout}ms`, {
    cause,
  });
};

const noop = function noop(): void {
  /* noop */
};

const isBootstrapTimeoutError = (
  error: unknown,
  timeout: number
): error is Error =>
  error instanceof Error &&
  error.message === `Bootstrap prefetch timed out after ${timeout}ms`;

const resolveBootstrapError = (
  timedOut: boolean,
  timeout: number,
  error: unknown
): Error => {
  if (timedOut && !isBootstrapTimeoutError(error, timeout)) {
    return createBootstrapTimeoutError(timeout, error);
  }

  return error instanceof Error ? error : new Error(String(error));
};

export const prefetchBootstrap = async (
  options: PrefetchBootstrapOptions
): Promise<BootstrapSnapshot> => {
  const {
    endpoint,
    authorization,
    headers,
    models,
    groups,
    schemaHash,
    timeout = DEFAULT_PREFETCH_TIMEOUT_MS,
  } = options;

  // Build request headers
  const requestHeaders: Record<string, string> = {
    ...headers,
    Accept: NDJSON_ACCEPT_HEADER,
  };

  if (authorization) {
    requestHeaders.Authorization = authorization;
  }

  // Build query params
  const params = new URLSearchParams();
  params.set("type", "full");

  if (models?.length) {
    params.set("onlyModels", models.join(","));
  }
  if (schemaHash) {
    params.set("schemaHash", schemaHash);
  }
  if (groups?.length) {
    params.set("syncGroups", groups.join(","));
  }

  // Build URL
  const baseEndpoint = normalizeSyncEndpoint(endpoint);
  const url = joinSyncUrl(baseEndpoint, "/bootstrap");
  const fullUrl = `${url}?${params.toString()}`;

  // Fetch with timeout
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  let removeAbortListener = noop;

  try {
    const response = await fetch(fullUrl, {
      headers: requestHeaders,
      method: "GET",
      signal: controller.signal,
    });

    // Ensure response OK
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Bootstrap prefetch failed: ${response.status} ${text}`);
    }

    // Get body
    if (!response.body) {
      throw new Error("Bootstrap prefetch response has no body");
    }

    // oxlint-disable-next-line promise/avoid-new -- Promise.race needs an abort-driven rejection path
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => {
        reject(createBootstrapTimeoutError(timeout));
      };

      removeAbortListener = (): void => {
        controller.signal.removeEventListener("abort", onAbort);
      };

      if (controller.signal.aborted) {
        onAbort();
        return;
      }

      controller.signal.addEventListener("abort", onAbort, { once: true });
    });

    const { rows, metadata, rowCount } = await Promise.race([
      readBootstrapStream(response.body),
      timeoutPromise,
    ]);

    const resolvedMetadata = ensureBootstrapMetadata(metadata);
    const snapshotSchemaHash = resolvedMetadata.schemaHash ?? schemaHash ?? "";

    return {
      fetchedAt: Date.now(),
      firstSyncId: resolveFirstSyncId(resolvedMetadata),
      groups: resolvedMetadata.subscribedSyncGroups,
      lastSyncId: resolvedMetadata.lastSyncId,
      rowCount,
      rows,
      schemaHash: snapshotSchemaHash,
      version: 1,
    };
  } catch (error) {
    throw resolveBootstrapError(timedOut, timeout, error);
  } finally {
    removeAbortListener();
    clearTimeout(timeoutId);
  }
};

const normalizeSyncEndpoint = (endpoint: string): string => {
  const trimmed = endpoint.replace(TRAILING_SLASH_RE, "");
  for (const suffix of KNOWN_SYNC_SUFFIXES) {
    if (trimmed.endsWith(suffix)) {
      return trimmed.slice(0, -suffix.length);
    }
  }
  return trimmed;
};

const joinSyncUrl = (base: string, path: string): string => {
  const normalizedBase = base.replace(TRAILING_SLASH_RE, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
};
