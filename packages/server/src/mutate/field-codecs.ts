import {
  toDateOnlyDateOrNull,
  toDateOnlyEpoch,
  toInstantDateOrNull,
  toInstantEpoch,
} from "../utils/dates.js";

export type FieldType =
  | "string"
  | "stringNull"
  | "number"
  | "date"
  | "dateNow"
  | "dateOnly";

export interface FieldSpec {
  type: FieldType;
  defaultValue?: unknown;
}

type TemporalInputKind = "dateOnly" | "instant";

export const parseTemporalInput = (
  kind: TemporalInputKind,
  value: unknown,
  key: string
): Date | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Invalid ${kind} value for ${key}`);
  }

  const parsed =
    kind === "dateOnly"
      ? toDateOnlyDateOrNull(value)
      : toInstantDateOrNull(value);

  if (parsed === null) {
    throw new Error(`Invalid ${kind} value for ${key}`);
  }

  return parsed;
};

const coerceInsertValue = (
  key: string,
  raw: unknown,
  spec: FieldSpec
): unknown => {
  switch (spec.type) {
    case "dateOnly": {
      return parseTemporalInput("dateOnly", raw, key);
    }
    case "date": {
      return parseTemporalInput("instant", raw, key);
    }
    case "dateNow": {
      return raw === null || raw === undefined
        ? new Date()
        : parseTemporalInput("instant", raw, key);
    }
    case "number": {
      return (raw as number) ?? spec.defaultValue ?? 0;
    }
    case "string": {
      return (raw as string) ?? spec.defaultValue;
    }
    case "stringNull": {
      return (raw as string | null) ?? null;
    }
    default: {
      return raw ?? spec.defaultValue;
    }
  }
};

const coerceUpdateValue = (
  key: string,
  raw: unknown,
  spec: FieldSpec | undefined
): unknown => {
  switch (spec?.type) {
    case "dateOnly": {
      return parseTemporalInput("dateOnly", raw, key);
    }
    case "date":
    case "dateNow": {
      return parseTemporalInput("instant", raw, key);
    }
    default: {
      return raw;
    }
  }
};

export const buildInsertData = (
  modelId: string | null,
  payload: Record<string, unknown>,
  fields: Record<string, FieldSpec>
): Record<string, unknown> => {
  const data: Record<string, unknown> = {};

  if (modelId !== null) {
    data.id = modelId;
  }

  for (const [column, spec] of Object.entries(fields)) {
    data[column] = coerceInsertValue(column, payload[column], spec);
  }

  return data;
};

export const buildUpdateData = (
  payload: Record<string, unknown>,
  allowedFields: Set<string>,
  fieldSpecs: Record<string, FieldSpec>
): Record<string, unknown> => {
  const updateData: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (!allowedFields.has(key) || value === undefined) {
      continue;
    }

    updateData[key] = coerceUpdateValue(key, value, fieldSpecs[key]);
  }

  return updateData;
};

const serializeSyncValue = (
  value: unknown,
  spec: FieldSpec | undefined
): unknown => {
  switch (spec?.type) {
    case "dateOnly": {
      return toDateOnlyEpoch(value);
    }
    case "date":
    case "dateNow": {
      return toInstantEpoch(value);
    }
    default: {
      return value;
    }
  }
};

export const serializeSyncData = (
  data: Record<string, unknown>,
  fieldSpecs: Record<string, FieldSpec>,
  options: {
    modelId?: string | null;
    keys?: Iterable<string>;
  } = {}
): Record<string, unknown> => {
  const keys = options.keys ? [...options.keys] : Object.keys(data);
  const serialized: Record<string, unknown> = {};

  if (typeof options.modelId === "string") {
    serialized.id = options.modelId;
  }

  for (const key of keys) {
    serialized[key] = serializeSyncValue(data[key], fieldSpecs[key]);
  }

  return serialized;
};
