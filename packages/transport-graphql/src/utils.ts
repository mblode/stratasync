import type { AuthProvider, RetryConfig } from "./types.js";
import { DEFAULT_RETRY_CONFIG } from "./types.js";

/**
 * Delays execution for a specified duration
 */
const delay = (ms: number): Promise<void> =>
  // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Calculates the delay for exponential backoff with jitter
 */
export const calculateBackoff = (
  attempt: number,
  config: RetryConfig
): number => {
  const exponentialDelay = config.baseDelay * 2 ** attempt;
  const clampedDelay = Math.min(exponentialDelay, config.maxDelay);

  // Add jitter
  const jitter = config.jitter ?? 0;
  if (jitter > 0) {
    const jitterAmount = clampedDelay * jitter;
    return clampedDelay + (Math.random() * 2 - 1) * jitterAmount;
  }

  return clampedDelay;
};

/**
 * Retries an async function with exponential backoff
 */
export const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  shouldRetry: (error: unknown) => boolean = () => true
): Promise<T> => {
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= config.maxRetries || !shouldRetry(error)) {
        throw error;
      }

      const backoffDelay = calculateBackoff(attempt, config);
      await delay(backoffDelay);
    }
  }

  // oxlint-disable-next-line no-throw-literal
  throw lastError;
};

/**
 * Creates an AbortController with a timeout
 */
const createTimeoutController = (
  timeoutMs: number
): {
  controller: AbortController;
  cleanup: () => void;
} => {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)),
    timeoutMs
  );

  return {
    cleanup: () => clearTimeout(timeoutId),
    controller,
  };
};

/**
 * Wraps a fetch call with timeout support
 */
const fetchWithTimeout = async (
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> => {
  const { controller, cleanup } = createTimeoutController(timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    cleanup();
  }
};

interface RequestHeaderOptions {
  token: string | null;
  headers?: Record<string, string>;
  accept?: string;
  contentType?: string;
}

/**
 * Builds request headers with auth token, accept, content-type, and custom headers
 */
export const buildRequestHeaders = (
  opts: RequestHeaderOptions
): Record<string, string> => {
  const result: Record<string, string> = {};

  if (opts.accept) {
    result.Accept = opts.accept;
  }
  if (opts.contentType) {
    result["Content-Type"] = opts.contentType;
  }

  if (opts.headers) {
    Object.assign(result, opts.headers);
  }

  if (opts.token) {
    result.Authorization = `Bearer ${opts.token}`;
  }

  return result;
};

/**
 * HTTP error with status code for robust error classification
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * Fetches a URL with optional timeout and checks for a successful response
 */
export const fetchChecked = async (
  url: string,
  init: RequestInit,
  timeoutMs: number | undefined,
  errorPrefix: string
): Promise<Response> => {
  const res = timeoutMs
    ? await fetchWithTimeout(url, init, timeoutMs)
    : await fetch(url, init);

  if (!res.ok) {
    const text = await res.text();
    throw new HttpError(res.status, `${errorPrefix}: ${res.status} ${text}`);
  }

  return res;
};

/**
 * Checks if an error is a network error
 */
export const isNetworkError = (error: unknown): boolean => {
  if (error instanceof Error) {
    return (
      error.name === "TypeError" ||
      error.message.includes("network") ||
      error.message.includes("fetch") ||
      error.message.includes("ECONNREFUSED") ||
      error.message.includes("ETIMEDOUT") ||
      error.message.includes("ENETUNREACH")
    );
  }
  return false;
};

/**
 * Checks if an error is a timeout error
 */
export const isTimeoutError = (error: unknown): boolean => {
  if (error instanceof Error) {
    return (
      error.name === "AbortError" ||
      error.message.includes("timeout") ||
      error.message.includes("aborted")
    );
  }
  return false;
};

const RETRYABLE_STATUS_RE = /\b(500|502|503|504|429)\b/;

/**
 * Checks if an error is retryable
 */
export const isRetryableError = (error: unknown): boolean => {
  if (isNetworkError(error) || isTimeoutError(error)) {
    return true;
  }

  if (error instanceof HttpError) {
    return error.status >= 500 || error.status === 429;
  }

  // Fallback: string matching for errors not thrown by fetchChecked
  if (error instanceof Error && RETRYABLE_STATUS_RE.test(error.message)) {
    return true;
  }

  return false;
};

const SYNC_ID_RE = /^\d+$/;

/**
 * Validates a string-encoded sync ID.
 */
export const parseSyncId = (value: unknown, fieldName = "syncId"): string => {
  if (typeof value !== "string") {
    throw new TypeError(`${fieldName} must be a string`);
  }

  if (!SYNC_ID_RE.test(value)) {
    throw new TypeError(`${fieldName} must be a string-encoded integer`);
  }

  return value;
};

/**
 * Resolves an auth token, falling back to refreshToken if available
 */
export const resolveAuthToken = async (
  auth: AuthProvider
): Promise<string | null> => {
  let token = await auth.getAccessToken();
  if (!token && auth.refreshToken) {
    token = await auth.refreshToken();
  }
  return token;
};
