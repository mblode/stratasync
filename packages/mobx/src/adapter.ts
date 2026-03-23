/* oxlint-disable max-classes-per-file */
import type {
  DisposeFn,
  ObservableArray,
  ObservableBox,
  ObservableMap,
  ObservableOptions,
  ReactionOptions,
  ReactivityAdapter,
} from "@stratasync/core";
import { setBoxFactory } from "@stratasync/core";
import { computed, observable, reaction, runInAction } from "mobx";

const toMobXObservableOptions = function toMobXObservableOptions(
  options?: ObservableOptions
): {
  deep?: boolean;
  name?: string;
} {
  if (!options) {
    return {};
  }

  return {
    deep: options.deep,
    name: options.name,
  };
};

class MobXBox<T> implements ObservableBox<T> {
  private readonly box: { get(): T; set(value: T): void };

  constructor(initialValue: T, options?: ObservableOptions) {
    this.box = observable.box(initialValue, toMobXObservableOptions(options));
  }

  get(): T {
    return this.box.get();
  }

  set(value: T): void {
    runInAction(() => {
      this.box.set(value);
    });
  }
}

class MobXMap<K, V> implements ObservableMap<K, V> {
  private readonly map: Map<K, V>;

  constructor(entries?: Iterable<[K, V]>, options?: ObservableOptions) {
    const initialEntries = entries ? new Map(entries) : undefined;
    const observableOptions = toMobXObservableOptions(options);

    if (Object.keys(observableOptions).length === 0) {
      this.map = observable.map<K, V>(initialEntries);
      return;
    }

    // oxlint-disable-next-line no-array-method-this-argument -- false positive for MobX observable.map options
    this.map = observable.map<K, V>(initialEntries, observableOptions);
  }

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): void {
    runInAction(() => {
      this.map.set(key, value);
    });
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    return runInAction(() => this.map.delete(key));
  }

  clear(): void {
    runInAction(() => {
      this.map.clear();
    });
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  get size(): number {
    return this.map.size;
  }

  // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
  forEach(callback: (value: V, key: K) => void): void {
    // oxlint-disable-next-line no-array-for-each
    this.map.forEach(callback);
  }
}

class MobXArray<T> implements ObservableArray<T> {
  private readonly array: T[];

  constructor(items?: T[], options?: ObservableOptions) {
    this.array = observable.array<T>(
      items ?? [],
      toMobXObservableOptions(options)
    );
  }

  get(index: number): T | undefined {
    return this.array[index];
  }

  toArray(): T[] {
    return [...this.array];
  }

  push(...items: T[]): number {
    return runInAction(() => this.array.push(...items));
  }

  pop(): T | undefined {
    return runInAction(() => this.array.pop());
  }

  remove(predicate: (item: T) => boolean): T[] {
    return runInAction(() => {
      const removed: T[] = [];
      for (let i = this.array.length - 1; i >= 0; i -= 1) {
        const item = this.array[i];
        if (item !== undefined && predicate(item)) {
          removed.push(item);
          this.array.splice(i, 1);
        }
      }
      return removed;
    });
  }

  replace(items: T[]): void {
    runInAction(() => {
      this.array.length = 0;
      this.array.push(...items);
    });
  }

  clear(): void {
    runInAction(() => {
      this.array.length = 0;
    });
  }

  find(predicate: (item: T) => boolean): T | undefined {
    return this.array.find(predicate);
  }

  filter(predicate: (item: T) => boolean): T[] {
    return this.array.filter(predicate);
  }

  map<U>(mapper: (item: T) => U): U[] {
    return this.array.map(mapper);
  }

  get length(): number {
    return this.array.length;
  }

  [Symbol.iterator](): Iterator<T> {
    return this.array[Symbol.iterator]();
  }
}

export const mobxReactivityAdapter: ReactivityAdapter = {
  batch(fn) {
    runInAction(fn);
  },

  computed<T>(getter: () => T, options?: ObservableOptions): { get(): T } {
    const c = computed(
      getter,
      options?.name ? { name: options.name } : undefined
    );
    return { get: () => c.get() };
  },

  createArray<T>(items?: T[], options?: ObservableOptions): ObservableArray<T> {
    return new MobXArray(items, options);
  },

  createBox<T>(initialValue: T, options?: ObservableOptions): ObservableBox<T> {
    return new MobXBox(initialValue, options);
  },

  createMap<K, V>(
    entries?: Iterable<[K, V]>,
    options?: ObservableOptions
  ): ObservableMap<K, V> {
    return new MobXMap(entries, options);
  },

  makeObservable<T extends object>(target: T, options?: ObservableOptions): T {
    return observable(target, undefined, toMobXObservableOptions(options));
  },

  reaction<T>(
    expression: () => T,
    effect: (value: T) => void,
    options?: ReactionOptions
  ): DisposeFn {
    return reaction(expression, effect, options);
  },

  runInAction<T>(fn: () => T): T {
    return runInAction(fn);
  },
};

/**
 * Registers the MobX observable.box factory with sync-core's observability system.
 * Call this to enable MobX reactivity for model properties without using the full adapter.
 */
let mobxObservabilityInitialized = false;

export const initMobXObservability = (): void => {
  if (mobxObservabilityInitialized) {
    return;
  }

  setBoxFactory((initialValue) => {
    const box = observable.box(initialValue);
    return {
      get: () => box.get(),
      set: (value) => {
        runInAction(() => {
          box.set(value);
        });
      },
    };
  });
  mobxObservabilityInitialized = true;
};

export const createMobXReactivity = (): ReactivityAdapter => {
  initMobXObservability();
  return mobxReactivityAdapter;
};

initMobXObservability();
