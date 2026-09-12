const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The widest instant a `Date` can hold: ±8.64e15 ms (ECMA-262 time-clip).
 *
 * A finite epoch outside that range neither throws nor returns null —
 * `new Date(8.64e15 + 1)` is an Invalid Date, whose `getTime()` is NaN. So the
 * `…OrNull` conversions below, which promise a usable `Date`, bound their input
 * rather than trusting `Number.isFinite`.
 *
 * The `…Epoch` functions deliberately do not: those run on egress, encoding a
 * value already stored into a sync action, and a stored number the client is
 * owed must reach it unchanged. Nulling it there would clear a field on every
 * client instead of rejecting one write. The bound belongs on ingress, where
 * `parseTemporalInput` turns a null into a thrown error and nothing is
 * persisted.
 */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

const isRepresentableEpoch = (value: unknown): boolean =>
  typeof value === "number" && Math.abs(value) <= MAX_EPOCH_MS;

const pad = (value: number): string => String(value).padStart(2, "0");

const parseDateOnlyParts = (
  value: string
): { year: number; month: number; day: number } | null => {
  if (!DATE_ONLY_PATTERN.test(value)) {
    return null;
  }

  const [yearRaw, monthRaw, dayRaw] = value.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);

  if (
    !(
      Number.isInteger(year) &&
      Number.isInteger(month) &&
      Number.isInteger(day)
    )
  ) {
    return null;
  }

  const epoch = Date.UTC(year, month - 1, day);
  const candidate = new Date(epoch);

  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() + 1 !== month ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }

  return { day, month, year };
};

const isCanonicalDateOnlyEpoch = (value: number): boolean =>
  Number.isFinite(value) && value % DATE_ONLY_DAY_MS === 0;

const parseInstantString = (value: string): number | null => {
  const trimmed = value.trim();

  if (
    trimmed.length === 0 ||
    DATE_ONLY_PATTERN.test(trimmed) ||
    !INSTANT_PATTERN.test(trimmed)
  ) {
    return null;
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
};

export const dateOnlyStringToEpoch = (value: string | null): number | null => {
  if (typeof value !== "string") {
    return null;
  }

  const parts = parseDateOnlyParts(value.trim());

  if (!parts) {
    return null;
  }

  return Date.UTC(parts.year, parts.month - 1, parts.day);
};

export const toDateOnlyEpoch = (value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    const epoch = value.getTime();

    if (Number.isNaN(epoch)) {
      return null;
    }

    const canonicalEpoch = Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth(),
      value.getUTCDate()
    );

    return epoch === canonicalEpoch ? canonicalEpoch : null;
  }

  if (typeof value === "number") {
    return isCanonicalDateOnlyEpoch(value) ? value : null;
  }

  if (typeof value === "string") {
    return dateOnlyStringToEpoch(value);
  }

  return null;
};

export const epochToDateOnlyString = (value: number | null): string | null => {
  const epoch = toDateOnlyEpoch(value);

  if (epoch === null) {
    return null;
  }

  const date = new Date(epoch);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
    date.getUTCDate()
  )}`;
};

export const toDateOnlyStringOrNull = (value: unknown): string | null =>
  epochToDateOnlyString(toDateOnlyEpoch(value));

export const toDateOnlyDateOrNull = (value: unknown): Date | null => {
  const epoch = toDateOnlyEpoch(value);
  return epoch === null || !isRepresentableEpoch(epoch)
    ? null
    : new Date(epoch);
};

export const toInstantEpoch = (value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    const epoch = value.getTime();
    return Number.isNaN(epoch) ? null : epoch;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    return parseInstantString(value);
  }

  return null;
};

export const toInstantDateOrNull = (value: unknown): Date | null => {
  const epoch = toInstantEpoch(value);
  return epoch === null || !isRepresentableEpoch(epoch)
    ? null
    : new Date(epoch);
};
