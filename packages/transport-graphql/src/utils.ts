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
    return Math.max(0, clampedDelay + (Math.random() * 2 - 1) * jitterAmount);
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
export const fetchWithTimeout = async (
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
  readonly body: string;

  constructor(status: number, message: string, body = "") {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
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
  const res =
    timeoutMs === undefined
      ? await fetch(url, init)
      : await fetchWithTimeout(url, init, timeoutMs);

  if (!res.ok) {
    const text = await res.text();
    throw new HttpError(
      res.status,
      `${errorPrefix}: ${res.status} ${text}`,
      text
    );
  }

  return res;
};

/**
 * Checks if an error is a network error
 */
export const isNetworkError = (error: unknown): boolean => {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      error.name === "TypeError" ||
      message.includes("network") ||
      message.includes("fetch") ||
      message.includes("econnrefused") ||
      message.includes("etimedout") ||
      message.includes("enetunreach")
    );
  }
  return false;
};

/**
 * Checks if an error is a timeout error
 */
export const isTimeoutError = (error: unknown): boolean => {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      error.name === "AbortError" ||
      message.includes("timeout") ||
      message.includes("timed out") ||
      message.includes("aborted")
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

export const isAuthHttpError = (error: unknown): error is HttpError =>
  error instanceof HttpError && (error.status === 401 || error.status === 403);

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

const normalizeError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export const notifyAuthError = (auth: AuthProvider, error: unknown): void => {
  auth.onAuthError?.(normalizeError(error));
};

export const executeWithAuthRetry = async <T>(
  auth: AuthProvider,
  operation: (token: string | null) => Promise<T>
): Promise<T> => {
  let token = await resolveAuthToken(auth);
  let hasRetriedWithRefresh = false;

  while (true) {
    try {
      return await operation(token);
    } catch (error) {
      if (
        isAuthHttpError(error) &&
        auth.refreshToken &&
        !hasRetriedWithRefresh
      ) {
        hasRetriedWithRefresh = true;
        token = await auth.refreshToken();
        if (token) {
          continue;
        }
      }

      if (isAuthHttpError(error)) {
        notifyAuthError(auth, error);
      }
      throw error;
    }
  }
};

export const createTransportError = <T extends Record<string, unknown>>(
  message: string,
  props: T
): Error & T => Object.assign(new Error(message), props);
