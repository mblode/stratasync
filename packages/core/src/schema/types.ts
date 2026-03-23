/**
 * Load strategy determines how and when model data is fetched
 * - instant: Loaded during bootstrap, always available
 * - lazy: Loaded on first access, cached thereafter
 * - partial: Loaded on demand, partially hydrated
 * - explicitlyRequested: Never auto-loaded, must be explicitly requested
 * - local: Never synced, only stored locally
 */
export type LoadStrategy =
  | "instant"
  | "lazy"
  | "partial"
  | "explicitlyRequested"
  | "local";

/**
 * Partial load mode determines hydration priority for partial models
 */
export type PartialLoadMode = "full" | "regular" | "lowPriority";

/**
 * Property types used by ModelRegistry
 */
export type PropertyType =
  | "property"
  | "ephemeralProperty"
  | "reference"
  | "referenceModel"
  | "referenceCollection"
  | "backReference"
  | "referenceArray";

/**
 * Transaction action types
 * I = Insert, U = Update, A = Archive, D = Delete, V = Unarchive
 */
export type TransactionAction = "I" | "U" | "A" | "D" | "V";

/**
 * Serializer interface for property values
 */
export interface PropertySerializer<T = unknown> {
  serialize(value: T): unknown;
  deserialize(value: unknown): T;
}

/**
 * Metadata describing a model property
 */
export interface PropertyMetadata {
  /** Property type */
  type: PropertyType;
  /** Whether property is lazily hydrated */
  lazy?: boolean;
  /** Custom serializer */
  serializer?: PropertySerializer<unknown>;
  /** Whether property is indexed */
  indexed?: boolean;
  /** Whether property can be null */
  nullable?: boolean;
  /** Referenced model name (for references) */
  referenceModel?: string;
  /** Inverse property name (for references) */
  inverseProperty?: string;
  /** Foreign key property name (for references) */
  foreignKey?: string;
  /** Through model name (for many-to-many) */
  through?: string;
}

/**
 * Metadata describing a model
 */
export interface ModelMetadata {
  /** Registered model name */
  name: string;
  /** Load strategy */
  loadStrategy: LoadStrategy;
  /** Partial load mode (for partial models) */
  partialLoadMode?: PartialLoadMode;
  /** Whether used for partial index dependencies */
  usedForPartialIndexes?: boolean;
  /** Schema version for the model */
  schemaVersion?: number;
  /** Optional table name override */
  tableName?: string;
  /** Primary key field name (defaults to id) */
  primaryKey?: string;
  /** Sync-group key field name (optional) */
  groupKey?: string;
  /** Composite indexes */
  indexes?: ModelIndexDefinition[];
}

/**
 * Options for @ClientModel decorator
 */
export interface ModelOptions {
  loadStrategy?: LoadStrategy;
  partialLoadMode?: PartialLoadMode;
  usedForPartialIndexes?: boolean;
  schemaVersion?: number;
  tableName?: string;
  groupKey?: string;
}

/**
 * Options for @Property decorator
 */
export interface PropertyOptions {
  lazy?: boolean;
  serializer?: PropertySerializer<unknown>;
}

/**
 * Options for @Reference decorator
 */
export interface ReferenceOptions extends PropertyOptions {
  nullable?: boolean;
  indexed?: boolean;
  foreignKey?: string;
}

/**
 * Options for @OneToMany / @ReferenceCollection decorator
 */
export interface ReferenceCollectionOptions extends PropertyOptions {
  indexed?: boolean;
  nullable?: boolean;
  foreignKey?: string;
}

/**
 * Options for @BackReference decorator
 */
export interface BackReferenceOptions extends PropertyOptions {
  foreignKey?: string;
}

/**
 * Options for @ReferenceArray decorator
 */
export interface ReferenceArrayOptions extends PropertyOptions {
  through?: string;
}

/**
 * Model constructor type
 */
export type ModelConstructor<T = unknown> = new (...args: unknown[]) => T;

/**
 * Snapshot of registry state used for schema hashing
 */
export interface ModelRegistrySnapshot {
  models: Record<
    string,
    {
      meta: ModelMetadata;
      properties: Record<string, PropertyMetadata>;
    }
  >;
}

/**
 * Field definition for schema-based registries.
 */
export interface FieldDefinition {
  /** Field type (informational; used by schema tooling) */
  type?: string;
  /** Whether field is indexed */
  indexed?: boolean;
  /** Whether field can be null */
  nullable?: boolean;
  /** Custom serializer */
  serializer?: PropertySerializer<unknown>;
  /** Whether field is lazily hydrated */
  lazy?: boolean;
  /** Whether field is ephemeral (not persisted) */
  ephemeral?: boolean;
}

/**
 * Relation kinds for schema-based registries.
 */
export type RelationKind =
  | "belongsTo"
  | "hasMany"
  | "manyToMany"
  | "reference"
  | "referenceModel"
  | "referenceCollection"
  | "backReference"
  | "referenceArray";

/**
 * Relation definition for schema-based registries.
 */
export interface RelationDefinition {
  /** Relation kind */
  kind?: RelationKind;
  /** Relation kind (alias) */
  type?: RelationKind;
  /** Referenced model name */
  model: string;
  /** Foreign key field name */
  foreignKey?: string;
  /** Inverse property name */
  inverseProperty?: string;
  /** Join/through model name (for many-to-many) */
  through?: string;
  /** Whether relation is lazily hydrated */
  lazy?: boolean;
  /** Custom serializer */
  serializer?: PropertySerializer<unknown>;
  /** Whether relation is indexed */
  indexed?: boolean;
  /** Whether relation can be null */
  nullable?: boolean;
}

/**
 * Composite index definition for a model.
 */
export interface ModelIndexDefinition {
  fields: string[];
  unique?: boolean;
}

/**
 * Model definition for schema-based registries.
 */
export interface ModelDefinition {
  /** Model name */
  name?: string;
  /** Load strategy */
  loadStrategy?: LoadStrategy;
  /** Partial load mode */
  partialLoadMode?: PartialLoadMode;
  /** Whether used for partial index dependencies */
  usedForPartialIndexes?: boolean;
  /** Schema version for the model */
  schemaVersion?: number;
  /** Optional table name override */
  tableName?: string;
  /** Primary key field name (defaults to id) */
  primaryKey?: string;
  /** Sync-group key field name (optional) */
  groupKey?: string;
  /** Field definitions */
  fields?: Record<string, FieldDefinition>;
  /** Relation definitions */
  relations?: Record<string, RelationDefinition>;
  /** Composite indexes */
  indexes?: ModelIndexDefinition[];
}

/**
 * Schema definition entry point.
 */
export interface SchemaDefinition {
  models: Record<string, ModelDefinition>;
}
