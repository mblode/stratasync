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
import {
  computed,
  makeObservable,
  observable,
  reaction,
  runInAction,
} from "mobx";

class MobXBox<T> implements ObservableBox<T> {
  value: T;

  constructor(initialValue: T) {
    this.value = initialValue;
    makeObservable(this, {
      value: observable,
    });
  }

  get(): T {
    return this.value;
  }

  set(value: T): void {
    runInAction(() => {
      this.value = value;
    });
  }
}

class MobXMap<K, V> implements ObservableMap<K, V> {
  private readonly map: Map<K, V>;

  constructor(entries?: Iterable<[K, V]>) {
    this.map = observable.map<K, V>(entries ? new Map(entries) : undefined);
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

  constructor(items?: T[]) {
    this.array = observable.array<T>(items ?? []);
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

  computed<T>(getter: () => T, _options?: ObservableOptions): { get(): T } {
    const c = computed(getter);
    return { get: () => c.get() };
  },

  createArray<T>(
    items?: T[],
    _options?: ObservableOptions
  ): ObservableArray<T> {
    return new MobXArray(items);
  },

  createBox<T>(
    initialValue: T,
    _options?: ObservableOptions
  ): ObservableBox<T> {
    return new MobXBox(initialValue);
  },

  createMap<K, V>(
    entries?: Iterable<[K, V]>,
    _options?: ObservableOptions
  ): ObservableMap<K, V> {
    return new MobXMap(entries);
  },

  makeObservable<T extends object>(target: T, _options?: ObservableOptions): T {
    return observable(target);
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
export const initMobXObservability = (): void => {
  setBoxFactory((initialValue) => observable.box(initialValue));
};

export const createMobXReactivity = (): ReactivityAdapter => {
  initMobXObservability();
  return mobxReactivityAdapter;
};
