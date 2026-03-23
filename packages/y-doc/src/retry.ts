import type { LiveEditingRetryConfig } from "./types.js";
import { DEFAULT_LIVE_EDITING_RETRY_CONFIG } from "./types.js";

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const normalizeRetryConfig = (
  retryConfig: Partial<LiveEditingRetryConfig> | undefined
): LiveEditingRetryConfig => {
  const baseDelayMs = Math.max(
    1,
    retryConfig?.baseDelayMs ?? DEFAULT_LIVE_EDITING_RETRY_CONFIG.baseDelayMs
  );
  const maxDelayMs = Math.max(
    baseDelayMs,
    retryConfig?.maxDelayMs ?? DEFAULT_LIVE_EDITING_RETRY_CONFIG.maxDelayMs
  );
  const maxRetries = Math.max(
    0,
    retryConfig?.maxRetries ?? DEFAULT_LIVE_EDITING_RETRY_CONFIG.maxRetries
  );
  const jitter = clamp(
    retryConfig?.jitter ?? DEFAULT_LIVE_EDITING_RETRY_CONFIG.jitter,
    0,
    1
  );

  return {
    baseDelayMs,
    jitter,
    maxDelayMs,
    maxRetries,
  };
};

export const calculateRetryDelay = (
  attempt: number,
  config: LiveEditingRetryConfig
): number => {
  const exponentialDelay = config.baseDelayMs * 2 ** attempt;
  const clampedDelay = Math.min(exponentialDelay, config.maxDelayMs);

  if (config.jitter <= 0) {
    return clampedDelay;
  }

  const jitterWindow = clampedDelay * config.jitter;
  const jitteredDelay = clampedDelay + (Math.random() * 2 - 1) * jitterWindow;
  return Math.max(0, Math.round(jitteredDelay));
};
