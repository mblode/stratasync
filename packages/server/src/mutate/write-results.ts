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

export const assertMutationTargetAffected = (result: unknown): void => {
  const affectedRows = getAffectedRowCount(result);
  if (affectedRows !== null && affectedRows < 1) {
    throw new Error("Invalid mutation: record not found");
  }
};
