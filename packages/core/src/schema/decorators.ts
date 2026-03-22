import type { Model } from "../model/base-model.js";
import { LazyCollection } from "../model/collection.js";
import {
  makeCachedReferenceModelProperty,
  makeObservableProperty,
} from "../model/observability.js";
import { assignIfDefined } from "../utils/assign.js";
import { ModelRegistry } from "./registry.js";
import type {
  BackReferenceOptions,
  ModelConstructor,
  ModelMetadata,
  ModelOptions,
  PropertyMetadata,
  PropertyOptions,
  ReferenceArrayOptions,
  ReferenceCollectionOptions,
  ReferenceOptions,
} from "./types.js";

export const ClientModel =
  (modelName: string, options: ModelOptions = {}) =>
  <T extends ModelConstructor>(modelConstructor: T): T => {
    const metadata: ModelMetadata = {
      loadStrategy: options.loadStrategy ?? "instant",
      name: modelName,
    };

    assignIfDefined(metadata, "partialLoadMode", options.partialLoadMode);
    assignIfDefined(
      metadata,
      "usedForPartialIndexes",
      options.usedForPartialIndexes
    );
    assignIfDefined(metadata, "schemaVersion", options.schemaVersion);
    assignIfDefined(metadata, "tableName", options.tableName);

    ModelRegistry.registerModel(modelName, modelConstructor, metadata);
    return modelConstructor;
  };

export const Property =
  (options: PropertyOptions = {}) =>
  (target: object, propertyKey: string | symbol): void => {
    const name = propertyKey.toString();
    const meta: PropertyMetadata = {
      type: "property",
    };

    assignIfDefined(meta, "lazy", options.lazy);
    assignIfDefined(meta, "serializer", options.serializer);

    ModelRegistry.registerProperty(target, name, meta);
    makeObservableProperty(target, name);
  };

const createReferenceDecorator =
  (
    refModelName: string,
    inverseProperty: string | undefined,
    options: ReferenceOptions
  ): ((target: object, propertyKey: string | symbol) => void) =>
  (target: object, propertyKey: string | symbol): void => {
    const name = propertyKey.toString();
    const referenceId = options.foreignKey ?? `${name}Id`;
    const indexed = options.indexed ?? (inverseProperty ? true : undefined);

    const referenceMeta: PropertyMetadata = {
      foreignKey: referenceId,
      referenceModel: refModelName,
      type: "reference",
    };

    assignIfDefined(referenceMeta, "inverseProperty", inverseProperty);
    assignIfDefined(referenceMeta, "lazy", options.lazy);
    assignIfDefined(referenceMeta, "serializer", options.serializer);
    assignIfDefined(referenceMeta, "indexed", indexed);
    assignIfDefined(referenceMeta, "nullable", options.nullable);

    const referenceModelMeta: PropertyMetadata = {
      foreignKey: referenceId,
      referenceModel: refModelName,
      type: "referenceModel",
    };

    assignIfDefined(referenceModelMeta, "inverseProperty", inverseProperty);
    assignIfDefined(referenceModelMeta, "lazy", options.lazy);
    assignIfDefined(referenceModelMeta, "serializer", options.serializer);
    assignIfDefined(referenceModelMeta, "indexed", indexed);
    assignIfDefined(referenceModelMeta, "nullable", options.nullable);

    ModelRegistry.registerProperty(target, referenceId, referenceMeta);
    ModelRegistry.registerProperty(target, name, referenceModelMeta);

    makeObservableProperty(target, referenceId);
    makeCachedReferenceModelProperty(target, name, referenceId, refModelName);
  };

export const Reference = (
  modelFactory: () => ModelConstructor,
  inverseProperty?: string,
  options: ReferenceOptions = {}
) => createReferenceDecorator(modelFactory().name, inverseProperty, options);

export const OneToMany =
  (options: ReferenceCollectionOptions = {}) =>
  (target: object, propertyKey: string | symbol): void => {
    const name = propertyKey.toString();
    const meta: PropertyMetadata = {
      type: "referenceCollection",
    };

    assignIfDefined(meta, "lazy", options.lazy);
    assignIfDefined(meta, "serializer", options.serializer);
    assignIfDefined(meta, "indexed", options.indexed);
    assignIfDefined(meta, "nullable", options.nullable);
    assignIfDefined(meta, "foreignKey", options.foreignKey);

    ModelRegistry.registerProperty(target, name, meta);

    const storageKey = `__collection:${name}`;
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: true,
      get() {
        const record = this as Record<string, unknown>;
        let collection = record[storageKey] as
          | LazyCollection<Model>
          | undefined;
        if (!collection) {
          collection = new LazyCollection();
          record[storageKey] = collection;
        }
        if (collection instanceof LazyCollection) {
          collection.attach(this as Model, name, {
            foreignKey: options.foreignKey,
          });
        }
        return collection;
      },
      set(value: unknown) {
        const record = this as Record<string, unknown>;
        if (value instanceof LazyCollection) {
          value.attach(this as Model, name, {
            foreignKey: options.foreignKey,
          });
        }
        record[storageKey] = value;
      },
    });
  };

export const BackReference =
  (options: BackReferenceOptions = {}) =>
  (target: object, propertyKey: string | symbol): void => {
    const name = propertyKey.toString();
    const meta: PropertyMetadata = {
      type: "backReference",
    };

    assignIfDefined(meta, "lazy", options.lazy);
    assignIfDefined(meta, "serializer", options.serializer);
    assignIfDefined(meta, "foreignKey", options.foreignKey);

    ModelRegistry.registerProperty(target, name, meta);
  };

export const ReferenceArray =
  (options: ReferenceArrayOptions = {}) =>
  (target: object, propertyKey: string | symbol): void => {
    const name = propertyKey.toString();
    const meta: PropertyMetadata = {
      type: "referenceArray",
    };

    assignIfDefined(meta, "lazy", options.lazy);
    assignIfDefined(meta, "serializer", options.serializer);
    assignIfDefined(meta, "through", options.through);

    ModelRegistry.registerProperty(target, name, meta);
  };
