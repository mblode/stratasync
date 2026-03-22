/* oxlint-disable max-classes-per-file */
import type { ObservableMap, ReactivityAdapter } from "@stratasync/core";

import type { ModelFactory } from "./types.js";

interface ModelInstanceLike {
  _applyUpdate?: (data: Record<string, unknown>) => void;
  makeObservable?: () => void;
  toJSON?: () => Record<string, unknown>;
}

const DEFAULT_IDENTITY_MAP_MAX_SIZE = 10_000;

const isModelInstanceLike = (value: unknown): value is ModelInstanceLike => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record._applyUpdate === "function" ||
    typeof record.makeObservable === "function"
  );
};

/**
 * Identity map for managing model instances
 * Ensures only one instance exists per model+id combination
 */
export class IdentityMap<T extends Record<string, unknown>> {
  private readonly map: ObservableMap<string, T>;
  private readonly modelName: string;
  private readonly reactivity: ReactivityAdapter;
  private readonly maxSize: number;
  private readonly accessOrder = new Map<string, number>();
  private accessTick = 0;
  private modelFactory?: ModelFactory;

  constructor(
    modelName: string,
    reactivity: ReactivityAdapter,
    modelFactory?: ModelFactory,
    maxSize = DEFAULT_IDENTITY_MAP_MAX_SIZE
  ) {
    this.modelName = modelName;
    this.reactivity = reactivity;
    this.modelFactory = modelFactory;
    this.maxSize = maxSize;
    this.map = reactivity.createMap<string, T>(undefined, {
      name: `IdentityMap:${modelName}`,
    });
  }

  setModelFactory(modelFactory?: ModelFactory): void {
    this.modelFactory = modelFactory;
  }

  // eslint-disable-next-line class-methods-use-this -- references generic type T
  private ensureObservable(instance: T): T {
    if (
      isModelInstanceLike(instance) &&
      typeof instance.makeObservable === "function"
    ) {
      instance.makeObservable();
    }
    return instance;
  }

  private toInstance(data: T): T {
    if (!this.modelFactory || isModelInstanceLike(data)) {
      return this.ensureObservable(data);
    }

    const instance = this.modelFactory(
      this.modelName,
      data as Record<string, unknown>
    ) as T;
    return this.ensureObservable(instance);
  }

  /**
   * Gets a model instance by ID
   */
  get(id: string): T | undefined {
    const value = this.map.get(id);
    if (value) {
      this.touch(id);
    }
    return value;
  }

  /**
   * Checks if a model instance exists
   */
  has(id: string): boolean {
    return this.map.has(id);
  }

  /**
   * Sets a model instance, replacing any existing instance
   */
  set(id: string, instance: T): void {
    this.reactivity.runInAction(() => {
      this.map.set(id, this.toInstance(instance));
      this.touch(id);
      this.evictIfNeeded();
    });
  }

  /**
   * Updates an existing model instance in place
   */
  update(id: string, changes: Partial<T>): T | undefined {
    const existing = this.map.get(id);
    if (!existing) {
      return undefined;
    }

    this.reactivity.runInAction(() => {
      this.applyChanges(existing, changes);
      this.touch(id);
    });

    return existing;
  }

  /**
   * Merges data into an existing instance or creates a new one
   */
  merge(id: string, data: Partial<T>): T {
    return this.reactivity.runInAction(() => {
      const existing = this.map.get(id);
      if (existing) {
        this.applyChanges(existing, data);
        this.touch(id);
        return existing;
      }
      const merged = this.toInstance(data as T);
      this.map.set(id, merged);
      this.touch(id);
      this.evictIfNeeded();
      return merged;
    });
  }

  /**
   * Deletes a model instance
   */
  delete(id: string): boolean {
    return this.reactivity.runInAction(() => {
      this.accessOrder.delete(id);
      return this.map.delete(id);
    });
  }

  /**
   * Clears all model instances
   */
  clear(): void {
    this.reactivity.runInAction(() => {
      this.map.clear();
      this.accessOrder.clear();
    });
  }

  /**
   * Gets all model instances
   */
  values(): T[] {
    return [...this.map.values()];
  }

  /**
   * Gets all model IDs
   */
  keys(): string[] {
    return [...this.map.keys()];
  }

  /**
   * Gets all entries
   */
  entries(): [string, T][] {
    return [...this.map.entries()];
  }

  /**
   * Gets the number of instances
   */
  get size(): number {
    return this.map.size;
  }

  /**
   * Iterates over all instances
   */
  // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
  forEach(callback: (value: T, key: string) => void): void {
    // oxlint-disable-next-line no-array-for-each
    this.map.forEach(callback);
  }

  /**
   * Finds an instance matching a predicate
   */
  find(predicate: (value: T) => boolean): T | undefined {
    for (const value of this.map.values()) {
      if (predicate(value)) {
        return value;
      }
    }
    return undefined;
  }

  /**
   * Filters instances matching a predicate
   */
  filter(predicate: (value: T) => boolean): T[] {
    return this.values().filter(predicate);
  }

  /**
   * Gets the model name
   */
  getModelName(): string {
    return this.modelName;
  }

  /**
   * Gets the underlying map (for advanced usage)
   */
  getRawMap(): Map<string, T> {
    return new Map(this.map.entries());
  }

  /**
   * Applies changes to an existing instance, preserving identity
   */
  // eslint-disable-next-line class-methods-use-this -- references generic type T
  private applyChanges(target: T, changes: Partial<T>): void {
    const candidate = target as ModelInstanceLike;

    if (typeof candidate._applyUpdate === "function") {
      candidate._applyUpdate(changes as Record<string, unknown>);
      return;
    }

    for (const key of Object.keys(changes)) {
      const newVal = (changes as Record<string, unknown>)[key];
      const oldVal = (target as Record<string, unknown>)[key];
      if (!Object.is(oldVal, newVal)) {
        (target as Record<string, unknown>)[key] = newVal;
      }
    }
  }

  private touch(id: string): void {
    this.accessTick += 1;
    this.accessOrder.set(id, this.accessTick);
  }

  private evictIfNeeded(): void {
    if (!Number.isFinite(this.maxSize) || this.maxSize <= 0) {
      return;
    }

    while (this.map.size > this.maxSize) {
      let oldestKey: string | null = null;
      let oldestAccess = Number.POSITIVE_INFINITY;

      for (const [key, accessTick] of this.accessOrder.entries()) {
        if (accessTick >= oldestAccess) {
          continue;
        }
        oldestKey = key;
        oldestAccess = accessTick;
      }

      if (!oldestKey) {
        break;
      }

      this.accessOrder.delete(oldestKey);
      this.map.delete(oldestKey);
    }
  }
}

/**
 * Manages identity maps for all model types
 */
export class IdentityMapRegistry {
  private readonly maps = new Map<
    string,
    IdentityMap<Record<string, unknown>>
  >();
  private readonly reactivity: ReactivityAdapter;
  private readonly maxSize: number;
  private modelFactory?: ModelFactory;

  constructor(
    reactivity: ReactivityAdapter,
    modelFactory?: ModelFactory,
    maxSize = DEFAULT_IDENTITY_MAP_MAX_SIZE
  ) {
    this.reactivity = reactivity;
    this.modelFactory = modelFactory;
    this.maxSize = maxSize;
  }

  setModelFactory(modelFactory?: ModelFactory): void {
    this.modelFactory = modelFactory;
    for (const map of this.maps.values()) {
      map.setModelFactory(modelFactory);
    }
  }

  /**
   * Gets or creates an identity map for a model type
   */
  getMap<T extends Record<string, unknown>>(modelName: string): IdentityMap<T> {
    let map = this.maps.get(modelName);
    if (!map) {
      map = new IdentityMap<Record<string, unknown>>(
        modelName,
        this.reactivity,
        this.modelFactory,
        this.maxSize
      );
      this.maps.set(modelName, map);
    }
    return map as IdentityMap<T>;
  }

  /**
   * Checks if a map exists for a model type
   */
  hasMap(modelName: string): boolean {
    return this.maps.has(modelName);
  }

  /**
   * Clears all identity maps
   */
  clearAll(): void {
    for (const map of this.maps.values()) {
      map.clear();
    }
  }

  /**
   * Clears a specific identity map
   */
  clear(modelName: string): void {
    this.maps.get(modelName)?.clear();
  }

  /**
   * Gets all model names with identity maps
   */
  getModelNames(): string[] {
    return [...this.maps.keys()];
  }

  /**
   * Executes a callback inside a single reactivity action.
   * All identity map mutations within the callback are batched —
   * observers only see the final state after the callback returns.
   */
  batch<T>(fn: () => T): T {
    return this.reactivity.runInAction(fn);
  }
}
