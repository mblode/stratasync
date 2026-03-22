import { CachedPromise } from "./cached-promise.js";

type MobxBoxes = Record<string, { get(): unknown; set(value: unknown): void }>;
type BoxFactory = (initialValue: unknown) => {
  get(): unknown;
  set(value: unknown): void;
};

interface ObservableInstance {
  _mobx?: MobxBoxes;
  __data?: Record<string, unknown>;
  propertyChanged?: (
    name: string,
    oldValue: unknown,
    newValue: unknown
  ) => void;
}

/**
 * Default box factory that creates a plain get/set wrapper with no reactivity.
 * Replaced at runtime by sync-mobx with a MobX observable.box factory.
 */
let boxFactory: BoxFactory = (initialValue: unknown) => {
  let value = initialValue;
  return {
    get: () => value,
    set: (v: unknown) => {
      value = v;
    },
  };
};

/**
 * Registers a custom box factory for creating observable property containers.
 * Called by @stratasync/mobx to plug in MobX observable.box at runtime.
 */
export const setBoxFactory = (factory: BoxFactory): void => {
  boxFactory = factory;
};

const ensureBox = (
  target: Record<string, { get(): unknown; set(value: unknown): void }>,
  key: string,
  initialValue: unknown
): { get(): unknown; set(value: unknown): void } => {
  const existing = target[key];
  if (existing) {
    return existing;
  }
  const box = boxFactory(initialValue);
  target[key] = box;
  return box;
};

const getBox = (
  target: Record<string, { get(): unknown; set(value: unknown): void }>,
  key: string
): { get(): unknown; set(value: unknown): void } | undefined => target[key];

const getBackingValue = (instance: unknown, key: string): unknown => {
  const data = (instance as { __data?: Record<string, unknown> }).__data;
  return data ? data[key] : undefined;
};

const setBackingValue = (
  instance: unknown,
  key: string,
  value: unknown
): void => {
  const data = (instance as { __data?: Record<string, unknown> }).__data;
  if (data) {
    data[key] = value;
  }
};

/**
 * Makes a property observable using Object.defineProperty.
 */
export const makeObservableProperty = (
  target: object,
  propertyName: string
): void => {
  Object.defineProperty(target, propertyName, {
    configurable: true,
    enumerable: true,
    get() {
      const self = this as ObservableInstance;
      const box = self._mobx ? getBox(self._mobx, propertyName) : undefined;
      if (box) {
        return box.get();
      }
      return getBackingValue(this, propertyName);
    },
    set(value: unknown) {
      const self = this as ObservableInstance;
      const { _mobx: boxes } = self;
      const oldValue = boxes
        ? (getBox(boxes, propertyName)?.get() ??
          getBackingValue(this, propertyName))
        : getBackingValue(this, propertyName);

      if (boxes) {
        const box = ensureBox(boxes, propertyName, value);
        box.set(value);
      }

      setBackingValue(this, propertyName, value);

      if (typeof self.propertyChanged === "function") {
        self.propertyChanged(propertyName, oldValue, value);
      }
    },
  });
};

/**
 * Defines a reference model property that proxies to a reference ID property.
 */
export const makeReferenceModelProperty = (
  target: object,
  propertyName: string,
  referenceIdKey: string,
  referenceModelName: string
): void => {
  Object.defineProperty(target, propertyName, {
    configurable: true,
    enumerable: true,
    get() {
      const id = (this as Record<string, unknown>)[referenceIdKey];
      if (typeof id !== "string") {
        return null;
      }
      const { store } = this as {
        store?: { get: (modelName: string, id: string) => unknown };
      };
      return store?.get(referenceModelName, id) ?? null;
    },
    set(value: unknown) {
      const refId = (value as { id?: string } | null)?.id ?? null;
      (this as Record<string, unknown>)[referenceIdKey] = refId;
    },
  });
};

const resolveCachedReference = <T>(
  store: { get: (modelName: string, id: string) => unknown | Promise<unknown> },
  modelName: string,
  id: string
): CachedPromise<T | undefined> => {
  const result = store.get(modelName, id);
  if (result instanceof CachedPromise) {
    return result as CachedPromise<T | undefined>;
  }
  // Handle synchronous values directly without wrapping in Promise
  if (!(result instanceof Promise)) {
    const value =
      result === null || result === undefined ? undefined : (result as T);
    return CachedPromise.resolve(value);
  }
  // Handle actual promises
  const promise = (async () => {
    const value = await result;
    return value === null || value === undefined ? undefined : (value as T);
  })();
  return new CachedPromise(promise);
};

const getCachedPromiseMap = (
  instance: unknown
): Map<string, { id: string | null; promise: CachedPromise<unknown> }> => {
  const target = instance as {
    __cachedPromises?: Map<
      string,
      { id: string | null; promise: CachedPromise<unknown> }
    >;
  };
  if (!target.__cachedPromises) {
    target.__cachedPromises = new Map();
  }
  return target.__cachedPromises;
};

/**
 * Defines a reference model property that returns a CachedPromise.
 */
export const makeCachedReferenceModelProperty = (
  target: object,
  propertyName: string,
  referenceIdKey: string,
  referenceModelName: string
): void => {
  Object.defineProperty(target, propertyName, {
    configurable: true,
    enumerable: true,
    get() {
      const id = (this as Record<string, unknown>)[referenceIdKey];
      if (typeof id !== "string") {
        return CachedPromise.resolve();
      }
      const { store } = this as {
        store?: {
          get: (modelName: string, id: string) => unknown | Promise<unknown>;
        };
      };
      if (!store) {
        return CachedPromise.resolve();
      }
      const cache = getCachedPromiseMap(this);
      const cached = cache.get(propertyName);
      if (cached && cached.id === id) {
        return cached.promise;
      }
      const promise = resolveCachedReference<unknown>(
        store,
        referenceModelName,
        id
      );
      cache.set(propertyName, { id, promise });
      return promise;
    },
    set(value: unknown) {
      if (value === null || value === undefined) {
        (this as Record<string, unknown>)[referenceIdKey] = null;
        return;
      }
      if (value instanceof CachedPromise) {
        const resolved = value.value as { id?: string } | null | undefined;
        if (resolved?.id) {
          (this as Record<string, unknown>)[referenceIdKey] = resolved.id;
        }
        return;
      }
      const refId = (value as { id?: string } | null)?.id ?? null;
      (this as Record<string, unknown>)[referenceIdKey] = refId;
    },
  });
};
