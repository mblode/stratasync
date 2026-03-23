/**
 * Returns a composite key for identifying a model instance.
 */
export const getModelKey = (modelName: string, id: string): string =>
  `${modelName}:${id}`;

/**
 * Extracts plain data from a model instance, using toJSON if available.
 */
export const getModelData = (
  value: Record<string, unknown>
): Record<string, unknown> => {
  const candidate = value as {
    toJSON?: () => Record<string, unknown>;
    toRawJSON?: () => Record<string, unknown>;
  };
  if (typeof candidate?.toRawJSON === "function") {
    return candidate.toRawJSON();
  }
  if (typeof candidate?.toJSON === "function") {
    return candidate.toJSON();
  }
  return value;
};

/**
 * Picks only the keys from `existing` that are present in `changes`,
 * producing a snapshot of original values before a mutation.
 */
export const pickOriginal = (
  existing: Record<string, unknown>,
  changes: Record<string, unknown>
): Record<string, unknown> => {
  const original: Record<string, unknown> = {};
  for (const key of Object.keys(changes)) {
    original[key] = existing[key];
  }
  return original;
};
