const toAffectedRowCount = (value: unknown): number | null => {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  return null;
};

export const getAffectedRowCount = (result: unknown): number | null => {
  const directCount = toAffectedRowCount(result);
  if (directCount !== null) {
    return directCount;
  }

  if (typeof result !== "object" || result === null) {
    return null;
  }

  return toAffectedRowCount((result as { rowCount?: unknown }).rowCount);
};

export const assertMutationTargetAffected = (
  result: unknown,
  target?: { id?: string; operation?: string }
): void => {
  const affectedRows = getAffectedRowCount(result);
  if (affectedRows !== null && affectedRows < 1) {
    /*
     * Same wording and the same parenthetical shape as `model-registry.ts`,
     * which already appends `(name/id)` to this message. The bare sentence
     * left the caller guessing which row in a batch that may carry many.
     */
    const detail = [target?.operation, target?.id].filter(Boolean).join(" ");
    throw new Error(
      `Invalid mutation: record not found${detail ? ` (${detail})` : ""}`
    );
  }
};
