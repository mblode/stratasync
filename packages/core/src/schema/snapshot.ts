/**
 * The model schema as a written-down artifact.
 *
 * `ModelRegistrySnapshot` is the in-memory shape; this module turns it into a
 * canonical JSON document that a non-TypeScript port can read, diff and pin.
 * Before this existed the snapshot was an implicit IDL — `computeSchemaHash`
 * canonicalized it privately and nothing else could see the result, so the
 * Swift port hashed model names only and the two disagreed about what a schema
 * change even was.
 */
import { isRegistrySnapshot, schemaToSnapshot } from "./normalize.js";
import type {
  ModelRegistrySnapshot,
  PropertyMetadata,
  SchemaDefinition,
} from "./types.js";

/**
 * Version of the document envelope, not of any application schema. Bump it
 * when the *shape* of this document changes (a field added to `meta`, a
 * renamed key), never when a caller's models change.
 *
 * It sits outside the hashed projection on purpose — see `canonicalSchemaJson`.
 */
export const MODEL_SNAPSHOT_VERSION = 1;

/** One property, reduced to the keys that describe how a value decodes. */
export type CanonicalProperty = Record<string, unknown>;

/** One model: its metadata and its properties, both canonically ordered. */
export interface CanonicalModelEntry {
  meta: Record<string, unknown>;
  properties: Record<string, CanonicalProperty>;
}

/** A serialized `ModelRegistrySnapshot`. Stable, sorted, JSON-safe. */
export interface ModelSnapshotDocument {
  models: Record<string, CanonicalModelEntry>;
  snapshotVersion: number;
}

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

/**
 * `serializer` is deliberately absent: it is a pair of functions, so it has no
 * JSON form and no cross-language meaning.
 */
const canonicalizeProperty = (prop: PropertyMetadata): CanonicalProperty =>
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

const canonicalizeIndexes = (
  indexes: ModelRegistrySnapshot["models"][string]["meta"]["indexes"]
): { fields: string[]; unique?: boolean }[] | undefined => {
  if (!(indexes && indexes.length > 0)) {
    return undefined;
  }

  return indexes
    .map(
      (index) =>
        sortObject({
          fields: [...index.fields],
          unique: index.unique,
        }) as { fields: string[]; unique?: boolean }
    )
    .toSorted((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
};

const canonicalizeModelEntry = (
  entry: ModelRegistrySnapshot["models"][string]
): CanonicalModelEntry => {
  const properties = Object.entries(entry.properties)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([propName, prop]) => [propName, canonicalizeProperty(prop)]);

  return {
    meta: sortObject({
      groupKey: entry.meta.groupKey,
      indexes: canonicalizeIndexes(entry.meta.indexes),
      loadStrategy: entry.meta.loadStrategy,
      name: entry.meta.name,
      partialLoadMode: entry.meta.partialLoadMode,
      primaryKey: entry.meta.primaryKey,
      schemaVersion: entry.meta.schemaVersion,
      tableName: entry.meta.tableName,
      usedForPartialIndexes: entry.meta.usedForPartialIndexes,
    }),
    properties: sortObject(Object.fromEntries(properties)) as Record<
      string,
      CanonicalProperty
    >,
  };
};

const toSnapshot = (
  input: ModelRegistrySnapshot | SchemaDefinition
): ModelRegistrySnapshot =>
  isRegistrySnapshot(input) ? input : schemaToSnapshot(input);

const canonicalizeModels = (
  snapshot: ModelRegistrySnapshot
): Record<string, CanonicalModelEntry> => {
  const models = Object.entries(snapshot.models)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => [name, canonicalizeModelEntry(entry)]);

  return sortObject(Object.fromEntries(models)) as Record<
    string,
    CanonicalModelEntry
  >;
};

/**
 * Serializes a registry snapshot (or a schema definition) into the canonical
 * document: keys sorted at every level, undefined dropped, no functions.
 *
 * Declaration order of models and properties does not survive, which is the
 * point — two registries that differ only in order serialize identically.
 */
export const serializeModelSnapshot = (
  input: ModelRegistrySnapshot | SchemaDefinition
): ModelSnapshotDocument => ({
  models: canonicalizeModels(toSnapshot(input)),
  snapshotVersion: MODEL_SNAPSHOT_VERSION,
});

/**
 * The exact bytes `computeSchemaHash` hashes: the `models` projection of the
 * document, and nothing else.
 *
 * **This projection is load-bearing.** The hash derived from it gates client
 * re-bootstrap, so widening or narrowing what appears here is a breaking
 * change that invalidates every persisted client schema hash and requires a
 * changeset. `snapshotVersion` is excluded for exactly that reason: versioning
 * the document must not, by itself, force every client to re-bootstrap.
 *
 * Note that the projection is currently wider than decoding strictly needs —
 * `loadStrategy`, for instance, changes the hash even though it cannot change
 * how a row decodes. Narrowing it is a deliberate future change; the
 * `compute-schema-hash` conformance vector pins the current behaviour so that
 * change is visible when someone makes it.
 */
export const canonicalSchemaJson = (
  input: ModelRegistrySnapshot | SchemaDefinition
): string => JSON.stringify({ models: canonicalizeModels(toSnapshot(input)) });
