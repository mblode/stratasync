/**
 * Returns a copy of `record` with every `undefined` value replaced by `null`.
 *
 * JSON drops `undefined` members, so a mutation payload that carries
 * `{ field: undefined }` reaches the server as `{}` and clears nothing. Undo
 * payloads restore fields that had no value before the change, and those must
 * be sent as an explicit `null` to actually clear the server-side value.
 */
export const replaceUndefinedWithNull = (
  record: Record<string, unknown>
): Record<string, unknown> => {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    normalized[key] = value === undefined ? null : value;
  }
  return normalized;
};
