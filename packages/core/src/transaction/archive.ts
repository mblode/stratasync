export interface ArchiveState extends Record<string, unknown> {
  archivedAt?: number | null;
}

export interface ArchiveTransactionOptions {
  original?: Record<string, unknown>;
  archivedAt?: number;
}

export interface UnarchiveTransactionOptions {
  original?: Record<string, unknown>;
}

const ISO_ARCHIVE_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+Z-]+)?$/;

export const readArchivedAt = (
  record: Record<string, unknown> | ArchiveState | undefined
): number | undefined => {
  const archivedAt = record?.archivedAt;
  if (typeof archivedAt === "number") {
    return archivedAt;
  }

  if (typeof archivedAt === "string") {
    const isIsoTimestamp = ISO_ARCHIVE_TIMESTAMP_REGEX.test(archivedAt);
    if (!isIsoTimestamp) {
      return undefined;
    }
    const parsed = Date.parse(archivedAt);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return undefined;
};

export const captureArchiveState = (
  record: Record<string, unknown> | ArchiveState | undefined
): ArchiveState => ({ archivedAt: readArchivedAt(record) ?? null });

export const createArchivePayload = (archivedAt?: number): ArchiveState => ({
  archivedAt: archivedAt ?? Date.now(),
});

export const createUnarchivePatch = (): ArchiveState => ({ archivedAt: null });

export const createUnarchivePayload = (): Record<string, unknown> => ({});
