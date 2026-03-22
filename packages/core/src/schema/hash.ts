import { isRegistrySnapshot, schemaToSnapshot } from "./normalize.js";
import type {
  ModelRegistrySnapshot,
  PropertyMetadata,
  SchemaDefinition,
} from "./types.js";

// oxlint-disable-next-line number-literal-case
const FNV_OFFSET_BASIS_64 = 0xcb_f2_9c_e4_84_22_23_25n;
// oxlint-disable-next-line number-literal-case
const FNV_PRIME_64 = 0x1_00_00_00_01_b3n;

const stableHash64 = (str: string): bigint => {
  let hash = FNV_OFFSET_BASIS_64;
  for (let i = 0; i < str.length; i += 1) {
    // biome-ignore lint/suspicious/noBitwiseOperators: FNV-1a requires XOR mixing.
    // oxlint-disable-next-line no-bitwise
    const mixed = hash ^ BigInt(str.codePointAt(i) ?? 0);
    hash = BigInt.asUintN(64, mixed * FNV_PRIME_64);
  }
  return hash;
};

/**
 * Converts a bigint hash to a hex string with padding
 */
const toHex = (num: bigint): string => num.toString(16).padStart(16, "0");

/**
 * Sorts object keys alphabetically and removes undefined values
 */
const sortObject = (obj: Record<string, unknown>): Record<string, unknown> => {
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj).toSorted();

  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined) {
      sorted[key] = value;
    }
  }

  return sorted;
};

const canonicalizeProperty = (
  prop: PropertyMetadata
): Record<string, unknown> =>
  sortObject({
    foreignKey: prop.foreignKey,
    indexed: prop.indexed,
    inverseProperty: prop.inverseProperty,
    lazy: prop.lazy,
    nullable: prop.nullable,
    referenceModel: prop.referenceModel,
    through: prop.through,
    type: prop.type,
  });

const canonicalizeModelEntry = (
  entry: ModelRegistrySnapshot["models"][string]
): Record<string, unknown> => {
  const properties = Object.entries(entry.properties)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([propName, prop]) => [propName, canonicalizeProperty(prop)]);

  return {
    meta: sortObject({
      loadStrategy: entry.meta.loadStrategy,
      name: entry.meta.name,
      partialLoadMode: entry.meta.partialLoadMode,
      schemaVersion: entry.meta.schemaVersion,
      tableName: entry.meta.tableName,
      usedForPartialIndexes: entry.meta.usedForPartialIndexes,
    }),
    properties: sortObject(Object.fromEntries(properties)),
  };
};

const canonicalizeSnapshot = (snapshot: ModelRegistrySnapshot): unknown => {
  const models = Object.entries(snapshot.models)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => [name, canonicalizeModelEntry(entry)]);

  return { models: sortObject(Object.fromEntries(models)) };
};

/**
 * Computes a deterministic hash of the model registry snapshot
 */
export const computeSchemaHash = (
  input: ModelRegistrySnapshot | SchemaDefinition
): string => {
  const snapshot = isRegistrySnapshot(input) ? input : schemaToSnapshot(input);
  const canonical = canonicalizeSnapshot(snapshot);
  const jsonStr = JSON.stringify(canonical);
  const hash = stableHash64(jsonStr);
  return toHex(hash);
};
