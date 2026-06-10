const jsonReplacer = (_: string, value: unknown): unknown => {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
};

/**
 * JSON.stringify with a bigint replacer. This is the net that keeps bigint
 * values from reaching raw JSON.stringify at redis + delta-frame egress.
 */
export const safeJsonStringify = (value: unknown): string =>
  JSON.stringify(value, jsonReplacer);
