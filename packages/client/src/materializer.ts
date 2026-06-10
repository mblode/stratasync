import type { SyncStore } from "@stratasync/core";
import { deserializeModelRecord, ModelRegistry } from "@stratasync/core";

import type { IdentityMapRegistry } from "./identity-map.js";
import type {
  ModelFactory,
  ModelFactoryFactory,
  ModelFactoryOptions,
  ModelStore,
} from "./types.js";

/**
 * Resolves a ModelFactory or ModelFactoryFactory into a ModelFactory.
 * A ModelFactoryFactory is a function that takes a store context and returns
 * a ModelFactory. Prefer return-type detection over function arity so plain
 * factories that use default/rest params are not misclassified.
 */
export const resolveModelFactory = (
  factory: ModelFactory | ModelFactoryFactory | undefined,
  modelStore: ModelStore & SyncStore
): ModelFactory | undefined => {
  if (!factory) {
    return undefined;
  }

  try {
    const resolved = (factory as ModelFactoryFactory)({ store: modelStore });
    if (typeof resolved === "function") {
      return resolved;
    }
  } catch {
    // Plain model factories can throw when probed with a context object.
  }

  return factory as ModelFactory;
};

const hydrateModelRecord = (
  registry: ModelRegistry,
  modelName: string,
  data: Record<string, unknown>,
  options: ModelFactoryOptions = {}
): Record<string, unknown> => {
  if (options.serialized === false) {
    return data;
  }

  return deserializeModelRecord(registry.getModelProperties(modelName), data);
};

/**
 * Default model factory: creates model instances using the constructor
 * registered in ModelRegistry, falling back to plain data objects.
 */
export const createDefaultModelFactory =
  (registry: ModelRegistry, store: SyncStore): ModelFactory =>
  (
    modelName: string,
    data: Record<string, unknown>,
    options: ModelFactoryOptions = {}
  ) => {
    const hydratedData = hydrateModelRecord(registry, modelName, data, options);
    const ctor = ModelRegistry.getModelConstructor(modelName);
    if (!ctor) {
      return hydratedData;
    }
    const instance = new ctor() as Record<string, unknown>;
    const candidate = instance as {
      store?: SyncStore;
      _applyUpdate?: (
        changes: Record<string, unknown>,
        updateOptions?: ModelFactoryOptions
      ) => void;
    };
    if ("store" in candidate) {
      candidate.store = store;
    }
    if (typeof candidate._applyUpdate === "function") {
      candidate._applyUpdate(hydratedData, { ...options, serialized: false });
    } else {
      Object.assign(instance, hydratedData);
    }
    return instance;
  };

/**
 * Builds the materialize function: turns raw record data into a model instance
 * via the resolved factory, preferring the live identity-map entry unless the
 * caller opts out. Delegating (de)serialization stays in the core codec.
 */
export const createMaterializer = (
  identityMaps: IdentityMapRegistry,
  resolvedModelFactory: ModelFactory | undefined
) => {
  const materialize = <T extends Record<string, unknown>>(
    modelName: string,
    id: string,
    data: T,
    materializeOptions: {
      preferCached?: boolean;
    } = {}
  ): T => {
    if (materializeOptions.preferCached !== false) {
      const map = identityMaps.getMap<T & Record<string, unknown>>(modelName);
      const cached = map.get(id);
      if (cached) {
        return cached as T;
      }
    }

    if (resolvedModelFactory) {
      return resolvedModelFactory(modelName, data as Record<string, unknown>, {
        serialized: false,
      }) as T;
    }

    return data;
  };

  return materialize;
};
