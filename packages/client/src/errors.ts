/**
 * Thrown when a storage write fails because the backing store is out of quota.
 *
 * Adapters detect the platform-specific quota error (IndexedDB
 * `QuotaExceededError` / DOMException code 22, or a localStorage write
 * throwing) and rethrow it as this typed error so callers can react
 * (e.g. prune, surface a "storage full" message) instead of pattern-matching
 * platform error shapes.
 */
export class StorageQuotaError extends Error {
  override readonly name = "StorageQuotaError";
  /** The original platform error, when available. */
  override readonly cause?: unknown;

  constructor(message = "Storage quota exceeded", cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

/**
 * Returns true when `error` looks like a storage quota-exceeded error from
 * IndexedDB or the Web Storage API.
 *
 * Detects the DOMException `name === "QuotaExceededError"`, the legacy
 * numeric `code === 22`, and the Firefox `NS_ERROR_DOM_QUOTA_REACHED` name.
 */
export const isQuotaExceededError = (error: unknown): boolean => {
  if (error instanceof StorageQuotaError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const candidate = error as { name?: string; code?: number };
  return (
    candidate.name === "QuotaExceededError" ||
    candidate.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    candidate.code === 22
  );
};

/**
 * Runs `operation`, rethrowing any quota-exceeded failure as a
 * {@link StorageQuotaError} and letting all other errors propagate unchanged.
 */
export const wrapQuotaErrors = async <T>(
  operation: () => Promise<T>
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (isQuotaExceededError(error)) {
      throw new StorageQuotaError(undefined, error);
    }
    throw error;
  }
};
