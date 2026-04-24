import type { DeltaPacket, SyncAction, SyncId } from "@stratasync/core";
import { isSyncIdGreaterThan, maxSyncId } from "@stratasync/core";

import {
  joinSyncUrl,
  normalizeSyncEndpoint,
  parseDeltaPacket,
} from "./protocol.js";
import type { AuthProvider, RetryConfig } from "./types.js";
import {
  buildRequestHeaders,
  executeWithAuthRetry,
  fetchWithTimeout,
  HttpError,
  isRetryableError,
  parseSyncId,
  retryWithBackoff,
} from "./utils.js";

export interface FetchDeltasOptions {
  syncEndpoint: string;
  afterSyncId: SyncId;
  auth: AuthProvider;
  headers?: Record<string, string>;
  limit?: number;
  groups?: string[];
  retryConfig?: RetryConfig;
  timeoutMs?: number;
}

const normalizeDeltaHttpError = (status: number, body: string): Error => {
  if (status === 409) {
    try {
      const parsed = JSON.parse(body) as {
        error?: unknown;
        message?: unknown;
      };
      if (parsed.error === "BOOTSTRAP_REQUIRED") {
        return Object.assign(
          new Error(
            typeof parsed.message === "string"
              ? parsed.message
              : "A fresh bootstrap is required before fetching deltas"
          ),
          { code: "BOOTSTRAP_REQUIRED" as const }
        );
      }
    } catch {
      /* noop */
    }
  }

  return new HttpError(status, `Fetch deltas failed: ${status} ${body}`, body);
};

/**
 * Fetches deltas from the server via REST
 */
export const fetchDeltas = async (
  opts: FetchDeltasOptions
): Promise<DeltaPacket> => {
  const response = await retryWithBackoff(
    () =>
      executeWithAuthRetry(opts.auth, async (token) => {
        const requestHeaders = buildRequestHeaders({
          accept: "application/json",
          headers: opts.headers,
          token,
        });
        const params = new URLSearchParams();
        params.set(
          "after",
          parseSyncId(opts.afterSyncId, "Fetch deltas afterSyncId")
        );
        if (opts.limit !== undefined) {
          params.set("limit", String(opts.limit));
        }
        if (opts.groups && opts.groups.length > 0) {
          params.set("syncGroups", opts.groups.join(","));
        }

        const syncBase = normalizeSyncEndpoint(opts.syncEndpoint);
        const url = `${joinSyncUrl(syncBase, "/deltas")}?${params.toString()}`;

        const res =
          opts.timeoutMs === undefined
            ? await fetch(url, { headers: requestHeaders, method: "GET" })
            : await fetchWithTimeout(
                url,
                { headers: requestHeaders, method: "GET" },
                opts.timeoutMs
              );

        if (!res.ok) {
          const body = await res.text();
          throw normalizeDeltaHttpError(res.status, body);
        }

        return res.json() as Promise<unknown>;
      }),
    opts.retryConfig,
    isRetryableError
  );

  const packet = parseDeltaPacket(response);
  if (!packet) {
    throw new Error("Delta response is not in a supported format");
  }

  return packet;
};

export interface FetchAllDeltasOptions {
  syncEndpoint: string;
  afterSyncId: SyncId;
  auth: AuthProvider;
  headers?: Record<string, string>;
  batchSize?: number;
  groups?: string[];
  retryConfig?: RetryConfig;
  timeoutMs?: number;
}

/**
 * Fetches all deltas since a sync ID, handling pagination
 */
// oxlint-disable-next-line require-yields, func-style
export async function* fetchAllDeltas(
  opts: FetchAllDeltasOptions
): AsyncGenerator<SyncAction, SyncId, unknown> {
  const batchSize = opts.batchSize ?? 1000;
  let currentSyncId = opts.afterSyncId;
  let lastSyncId = opts.afterSyncId;

  while (true) {
    const packet = await fetchDeltas({
      afterSyncId: currentSyncId,
      auth: opts.auth,
      groups: opts.groups,
      headers: opts.headers,
      limit: batchSize,
      retryConfig: opts.retryConfig,
      syncEndpoint: opts.syncEndpoint,
      timeoutMs: opts.timeoutMs,
    });

    for (const action of packet.actions) {
      yield action;
      lastSyncId = maxSyncId(lastSyncId, action.id);
    }

    lastSyncId = maxSyncId(lastSyncId, packet.lastSyncId);

    if (!packet.hasMore || packet.actions.length === 0) {
      break;
    }

    if (!isSyncIdGreaterThan(packet.lastSyncId, currentSyncId)) {
      throw new Error(
        `Delta pagination did not advance beyond sync ID ${currentSyncId}`
      );
    }

    currentSyncId = packet.lastSyncId;
  }

  return lastSyncId;
}
