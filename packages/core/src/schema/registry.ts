import { assignOptionalFields } from "../utils/assign.js";
import { computeSchemaHash } from "./hash.js";
import {
  isRegistrySnapshot,
  schemaToSnapshot,
  snapshotToSchemaDefinition,
} from "./normalize.js";
import type {
  ModelConstructor,
  ModelDefinition,
  ModelMetadata,
  ModelRegistrySnapshot,
  PropertyMetadata,
  SchemaDefinition,
} from "./types.js";

/**
 * Runtime registry for model metadata for model metadata.
 *
 * Static methods operate on the global decorator-driven registry, populated at
 * import time by @ClientModel/@Property decorators.
 *
 * Instance methods operate on a frozen schema snapshot, used by transport
 * layers and server-side code.
 */
export class ModelRegistry {
  static modelLookup = new Map<string, ModelConstructor>();
  static modelMetadata = new Map<string, ModelMetadata>();
  static modelPropertyLookup = new Map<string, Map<string, PropertyMetadata>>();
  static modelReferencedPropertyLookup = new Map<
    string,
    Map<string, PropertyMetadata>
  >();
  static __schemaHash = "";

  private static constructorLookup = new WeakMap<ModelConstructor, string>();
  private static pendingProperties = new WeakMap<
    ModelConstructor,
    Map<string, PropertyMetadata>
  >();

  private readonly snapshotData: ModelRegistrySnapshot;
  private readonly schemaHash: string;
  private readonly models: Map<string, ModelDefinition>;

  constructor(schema?: SchemaDefinition | ModelRegistrySnapshot) {
    const source = schema ?? ModelRegistry.snapshot();
    const snapshot = isRegistrySnapshot(source)
      ? source
      : schemaToSnapshot(source);
    const definition = isRegistrySnapshot(source)
      ? snapshotToSchemaDefinition(source)
      : source;

    this.snapshotData = snapshot;
    this.schemaHash = computeSchemaHash(snapshot);
    this.models = new Map();

    for (const [name, model] of Object.entries(definition.models)) {
      const normalized = ModelRegistry.normalizeModelDefinition(name, model);
      this.models.set(name, normalized);
    }
  }

  /**
   * Registers a model and finalizes any pending property metadata.
   */
  static registerModel(
    modelName: string,
    ctor: ModelConstructor,
    metadata: ModelMetadata
  ): void {
    ModelRegistry.modelLookup.set(modelName, ctor);
    ModelRegistry.modelMetadata.set(modelName, metadata);
    ModelRegistry.constructorLookup.set(ctor, modelName);

    const pending = ModelRegistry.pendingProperties.get(ctor);
    if (pending) {
      ModelRegistry.registerPropertyMap(modelName, pending);
    }

    ModelRegistry.__schemaHash = "";
  }

  /**
   * Registers a property for a model constructor or model name.
   */
  static registerProperty(
    target: ModelConstructor | object,
    propertyName: string,
    metadata: PropertyMetadata
  ): void {
    const ctor = ModelRegistry.resolveConstructor(target);
    const modelName = ModelRegistry.constructorLookup.get(ctor);

    if (modelName) {
      ModelRegistry.registerPropertyMap(
        modelName,
        new Map([[propertyName, metadata]])
      );
      ModelRegistry.__schemaHash = "";
      return;
    }

    const pending =
      ModelRegistry.pendingProperties.get(ctor) ??
      new Map<string, PropertyMetadata>();
    pending.set(propertyName, metadata);
    ModelRegistry.pendingProperties.set(ctor, pending);
  }

  /**
   * Global: Returns the model metadata from the global decorator registry.
   */
  static getModelMetadata(modelName: string): ModelMetadata | undefined {
    return ModelRegistry.modelMetadata.get(modelName);
  }

  /**
   * Snapshot: Returns the model metadata from this schema snapshot.
   */
  getModelMetadata(modelName: string): ModelMetadata | undefined {
    return this.snapshotData.models[modelName]?.meta;
  }

  /**
   * Returns the model constructor.
   */
  static getModelConstructor(modelName: string): ModelConstructor | undefined {
    return ModelRegistry.modelLookup.get(modelName);
  }

  /**
   * Returns the model name for a constructor.
   */
  static getModelName(ctor: ModelConstructor): string | undefined {
    return ModelRegistry.constructorLookup.get(ctor);
  }

  /**
   * Global: Returns all model names from the global decorator registry.
   */
  static getModelNames(): string[] {
    return [...ModelRegistry.modelLookup.keys()];
  }

  /**
   * Snapshot: Returns all model names from this schema snapshot.
   */
  getModelNames(): string[] {
    return Object.keys(this.snapshotData.models);
  }

  /**
   * Global: Checks whether a model is registered in the global decorator registry.
   */
  static hasModel(modelName: string): boolean {
    return ModelRegistry.modelMetadata.has(modelName);
  }

  /**
   * Snapshot: Checks whether a model exists in this schema snapshot.
   */
  hasModel(modelName: string): boolean {
    return modelName in this.snapshotData.models;
  }

  /**
   * Global: Returns all model metadata entries from the global decorator registry.
   */
  static getModelMetadataEntries(): [string, ModelMetadata][] {
    return [...ModelRegistry.modelMetadata.entries()];
  }

  /**
   * Snapshot: Returns all model metadata entries from this schema snapshot.
   */
  getModelMetadataEntries(): [string, ModelMetadata][] {
    return Object.entries(this.snapshotData.models).map(([name, entry]) => [
      name,
      entry.meta,
    ]);
  }

  /**
   * Global: Returns bootstrap model names (instant load strategy) from the global decorator registry.
   */
  static getBootstrapModelNames(): string[] {
    return ModelRegistry.getModelMetadataEntries()
      .filter(([, meta]) => meta.loadStrategy === "instant")
      .map(([name]) => name);
  }

  /**
   * Snapshot: Returns bootstrap model names (instant load strategy) from this schema snapshot.
   */
  getBootstrapModelNames(): string[] {
    return this.getAllModels()
      .filter((model) => model.loadStrategy === "instant")
      .map((model) => model.name ?? "");
  }

  /**
   * Global: Returns models that should hydrate eagerly from local state.
   * Includes instant models plus partial models marked as full-priority.
   */
  static getEagerHydrationModelNames(): string[] {
    return ModelRegistry.getModelMetadataEntries()
      .filter(
        ([, meta]) =>
          meta.loadStrategy === "instant" ||
          (meta.loadStrategy === "partial" && meta.partialLoadMode === "full")
      )
      .map(([name]) => name);
  }

  /**
   * Snapshot: Returns models that should hydrate eagerly from local state.
   * Includes instant models plus partial models marked as full-priority.
   */
  getEagerHydrationModelNames(): string[] {
    return this.getAllModels()
      .filter(
        (model) =>
          model.loadStrategy === "instant" ||
          (model.loadStrategy === "partial" && model.partialLoadMode === "full")
      )
      .map((model) => model.name ?? "");
  }

  /**
   * Global: Returns partial model names (lazy-hydrated) from the global decorator registry.
   */
  static getPartialModelNames(): string[] {
    return ModelRegistry.getModelMetadataEntries()
      .filter(([, meta]) => meta.loadStrategy === "partial")
      .map(([name]) => name);
  }

  /**
   * Snapshot: Returns partial model names (lazy-hydrated) from this schema snapshot.
   */
  getPartialModelNames(): string[] {
    return this.getPartialModels().map((model) => model.name ?? "");
  }

  /**
   * Global: Returns property metadata for a model from the global decorator registry.
   */
  static getModelProperties(modelName: string): Map<string, PropertyMetadata> {
    return ModelRegistry.modelPropertyLookup.get(modelName) ?? new Map();
  }

  /**
   * Snapshot: Returns property metadata for a model from this schema snapshot.
   */
  getModelProperties(modelName: string): Map<string, PropertyMetadata> {
    const props = this.snapshotData.models[modelName]?.properties ?? {};
    return new Map(Object.entries(props));
  }

  /**
   * Returns referenced property metadata for a model.
   */
  static getReferencedProperties(
    modelName: string
  ): Map<string, PropertyMetadata> {
    return (
      ModelRegistry.modelReferencedPropertyLookup.get(modelName) ?? new Map()
    );
  }

  /**
   * Global: Returns property names for hashing and storage from the global decorator registry.
   */
  static getPropertyNames(modelName: string): string[] {
    return [...ModelRegistry.getModelProperties(modelName).keys()].toSorted();
  }

  /**
   * Snapshot: Returns property names for hashing and storage from this schema snapshot.
   */
  getPropertyNames(modelName: string): string[] {
    return [...this.getModelProperties(modelName).keys()].toSorted();
  }

  /**
   * Global: Returns the schema hash from the global decorator registry.
   */
  static getSchemaHash(): string {
    if (!ModelRegistry.__schemaHash) {
      ModelRegistry.__schemaHash = computeSchemaHash(ModelRegistry.snapshot());
    }
    return ModelRegistry.__schemaHash;
  }

  /**
   * Snapshot: Returns the schema hash from this schema snapshot.
   */
  getSchemaHash(): string {
    return this.schemaHash;
  }

  /**
   * Global: Creates a snapshot of the global decorator registry.
   */
  static snapshot(): ModelRegistrySnapshot {
    const models: ModelRegistrySnapshot["models"] = {};

    for (const [name, meta] of ModelRegistry.modelMetadata.entries()) {
      const props = ModelRegistry.modelPropertyLookup.get(name) ?? new Map();
      models[name] = {
        meta,
        properties: Object.fromEntries(props.entries()),
      };
    }

    return { models };
  }

  /**
   * Snapshot: Returns this frozen schema snapshot.
   */
  snapshot(): ModelRegistrySnapshot {
    return this.snapshotData;
  }

  private static registerPropertyMap(
    modelName: string,
    properties: Map<string, PropertyMetadata>
  ): void {
    const existing =
      ModelRegistry.modelPropertyLookup.get(modelName) ?? new Map();
    for (const [propName, meta] of properties.entries()) {
      existing.set(propName, meta);

      if (
        meta.type === "referenceModel" ||
        meta.type === "referenceCollection" ||
        meta.type === "backReference" ||
        meta.type === "referenceArray"
      ) {
        const referenced =
          ModelRegistry.modelReferencedPropertyLookup.get(modelName) ??
          new Map();
        referenced.set(propName, meta);
        ModelRegistry.modelReferencedPropertyLookup.set(modelName, referenced);
      }
    }
    ModelRegistry.modelPropertyLookup.set(modelName, existing);
  }

  private static resolveConstructor(
    target: ModelConstructor | object
  ): ModelConstructor {
    if (typeof target === "function") {
      return target as ModelConstructor;
    }
    return (target as { constructor: ModelConstructor }).constructor;
  }

  private static normalizeModelDefinition(
    name: string,
    model: ModelDefinition
  ): ModelDefinition {
    const primaryKey = model.primaryKey ?? "id";
    const fields = model.fields ?? {};
    const normalizedFields = fields[primaryKey]
      ? fields
      : { ...fields, [primaryKey]: {} };

    const normalized: ModelDefinition = {
      fields: normalizedFields,
      indexes: model.indexes ?? [],
      loadStrategy: model.loadStrategy ?? "instant",
      name: model.name ?? name,
      primaryKey,
      relations: model.relations ?? {},
    };

    assignOptionalFields(normalized, model, [
      "partialLoadMode",
      "usedForPartialIndexes",
      "schemaVersion",
      "tableName",
      "groupKey",
    ]);

    return normalized;
  }

  /**
   * Returns the model definition.
   */
  getModel(modelName: string): ModelDefinition | undefined {
    return this.models.get(modelName);
  }

  /**
   * Returns all model definitions.
   */
  getAllModels(): ModelDefinition[] {
    return [...this.models.values()];
  }

  /**
   * Returns model definitions that should be loaded during bootstrap.
   */
  getBootstrapModels(): ModelDefinition[] {
    return this.getAllModels().filter(
      (model) => model.loadStrategy === "instant"
    );
  }

  /**
   * Returns model definitions that are partial (lazy-hydrated).
   */
  getPartialModels(): ModelDefinition[] {
    return this.getAllModels().filter(
      (model) => model.loadStrategy === "partial"
    );
  }

  /**
   * Returns the primary key for a model (defaults to id).
   */
  getPrimaryKey(modelName: string): string {
    return this.models.get(modelName)?.primaryKey ?? "id";
  }
}
