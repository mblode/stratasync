/**
 * Assigns a value to a target property only if the value is not undefined.
 */
export const assignIfDefined = <T, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined
): void => {
  if (value !== undefined) {
    target[key] = value;
  }
};

/**
 * Copies multiple optional fields from source to target, skipping undefined values.
 */
export const assignOptionalFields = <T, S>(
  target: T,
  source: S,
  keys: (keyof T & keyof S)[]
): void => {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) {
      (target as Record<string, unknown>)[key as string] = value;
    }
  }
};
