// Delta-packet parsing lives in @stratasync/core (single source of truth);
// re-exported so existing `./protocol.js` import sites stay stable.
export { parseDeltaPacket } from "@stratasync/core";

const SYNC_ENDPOINT_SUFFIXES = ["/bootstrap", "/batch", "/deltas", "/mutate"];
const TRAILING_SLASH_RE = /\/+$/;

/**
 * Normalizes a sync endpoint to its base path (e.g., /sync)
 */
export const normalizeSyncEndpoint = (endpoint: string): string => {
  const trimmed = endpoint.replace(TRAILING_SLASH_RE, "");
  for (const suffix of SYNC_ENDPOINT_SUFFIXES) {
    if (trimmed.endsWith(suffix)) {
      return trimmed.slice(0, -suffix.length);
    }
  }
  return trimmed;
};

/**
 * Joins a base URL with a path segment
 */
export const joinSyncUrl = (base: string, path: string): string => {
  const normalizedBase = base.replace(TRAILING_SLASH_RE, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
};
