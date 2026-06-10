import type { PropertyMetadata, PropertySerializer } from "./types.js";

/**
 * Determines whether a value is already in its serialized wire form for the
 * given serializer.
 *
 * A value round-trips identically (`serialize(deserialize(value)) === value`)
 * only when it is already serialized, so this lets the encoder avoid
 * double-serializing values that arrived pre-serialized (e.g. from storage).
 */
export const isAlreadySerializedValue = (
  serializer: Pick<PropertySerializer, "deserialize" | "serialize">,
  value: unknown
): boolean => {
  try {
    return Object.is(
      serializer.serialize(serializer.deserialize(value)),
      value
    );
  } catch {
    return false;
  }
};

/**
 * Serializes a model record to its wire representation using the per-property
 * serializers in `properties`.
 *
 * `id` and `undefined` values pass through untouched. Values that are already
 * serialized are left as-is to avoid double-serialization.
 */
export const serializeModelRecord = (
  properties: Map<string, PropertyMetadata>,
  data: Record<string, unknown>
): Record<string, unknown> => {
  const serialized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (key === "id" || value === undefined) {
      serialized[key] = value;
      continue;
    }

    const serializer = properties.get(key)?.serializer;
    if (!serializer) {
      serialized[key] = value;
      continue;
    }

    serialized[key] = isAlreadySerializedValue(serializer, value)
      ? value
      : serializer.serialize(value);
  }

  return serialized;
};

/**
 * Deserializes a wire model record back into runtime values using the
 * per-property serializers in `properties`.
 *
 * `id` and `undefined` values pass through untouched. When `properties` is
 * empty the record is returned as-is.
 */
export const deserializeModelRecord = (
  properties: Map<string, PropertyMetadata>,
  data: Record<string, unknown>
): Record<string, unknown> => {
  if (properties.size === 0) {
    return data;
  }

  const deserialized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "id" || value === undefined) {
      deserialized[key] = value;
      continue;
    }

    const serializer = properties.get(key)?.serializer;
    deserialized[key] = serializer ? serializer.deserialize(value) : value;
  }

  return deserialized;
};
