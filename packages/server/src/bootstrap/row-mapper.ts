import type { CursorConfig } from "../config.js";
import { toDateOnlyEpoch, toInstantEpoch } from "../utils/dates.js";

export interface BootstrapFieldDef {
  fields: readonly string[];
  dateOnlyFields?: readonly string[];
  instantFields?: readonly string[];
}

export const normalizeModelId = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  return null;
};

/**
 * Maps a raw DB row to the bootstrap wire shape: each declared field (with
 * date-only/instant fields normalized to epochs), then `id`.
 *
 * The id is assigned AFTER the fields, so JSON key order is wire-visible: if
 * "id" appears in `fields` it keeps its position there; otherwise it is appended
 * last. Do not reorder.
 */
export const mapRow = (
  item: Record<string, unknown>,
  fieldDef: BootstrapFieldDef,
  cursor: CursorConfig
): Record<string, unknown> => {
  const dateOnlySet = new Set(fieldDef.dateOnlyFields);
  const instantSet = new Set(fieldDef.instantFields);
  const row: Record<string, unknown> = {};

  for (const field of fieldDef.fields) {
    if (dateOnlySet.has(field)) {
      row[field] = toDateOnlyEpoch(item[field]);
      continue;
    }

    if (instantSet.has(field)) {
      row[field] = toInstantEpoch(item[field]);
      continue;
    }

    row[field] = item[field];
  }

  row.id =
    cursor.type === "simple" ? item[cursor.idField] : cursor.syntheticId(item);

  return row;
};

/**
 * Serializes a mapped row to an NDJSON line. The `__class` discriminator is
 * emitted first, then the row fields (so id position follows mapRow's rule).
 */
export const serializeBatchRow = (
  modelName: string,
  row: Record<string, unknown>
): string =>
  JSON.stringify({
    __class: modelName,
    ...row,
  });
