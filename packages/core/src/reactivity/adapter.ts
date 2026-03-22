/**
 * Reactivity adapter interface for integrating with state management libraries
 * (MobX, Zustand, Jotai, etc.)
 *
 * The sync engine uses this adapter to make model instances reactive
 * without being coupled to a specific state management solution.
 */

/**
 * Observable value container
 */
export interface ObservableBox<T> {
  /** Get the current value */
  get(): T;
  /** Set a new value */
  set(value: T): void;
}

/**
 * Observable map container
 */
export interface ObservableMap<K, V> {
  /** Get a value by key */
  get(key: K): V | undefined;
  /** Set a value by key */
  set(key: K, value: V): void;
  /** Check if key exists */
  has(key: K): boolean;
  /** Delete a key */
  delete(key: K): boolean;
  /** Clear all entries */
  clear(): void;
  /** Get all keys */
  keys(): IterableIterator<K>;
  /** Get all values */
  values(): IterableIterator<V>;
  /** Get all entries */
  entries(): IterableIterator<[K, V]>;
  /** Number of entries */
  size: number;
  /** Iterate over entries */
  forEach(callback: (value: V, key: K) => void): void;
}

/**
 * Observable array container
 */
export interface ObservableArray<T> {
  /** Get item at index */
  get(index: number): T | undefined;
  /** Get the underlying array */
  toArray(): T[];
  /** Push items to the end */
  push(...items: T[]): number;
  /** Remove and return the last item */
  pop(): T | undefined;
  /** Remove items by predicate */
  remove(predicate: (item: T) => boolean): T[];
  /** Replace all items */
  replace(items: T[]): void;
  /** Clear all items */
  clear(): void;
  /** Find an item */
  find(predicate: (item: T) => boolean): T | undefined;
  /** Filter items */
  filter(predicate: (item: T) => boolean): T[];
  /** Map items */
  map<U>(mapper: (item: T) => U): U[];
  /** Array length */
  length: number;
  /** Iterate over items */
  [Symbol.iterator](): Iterator<T>;
}

/**
 * Options for creating observable objects
 */
export interface ObservableOptions {
  /** Make the object deeply observable */
  deep?: boolean;
  /** Name for debugging */
  name?: string;
}

/**
 * Batch update function type
 */
export type BatchUpdateFn = (fn: () => void) => void;

/**
 * Dispose function type
 */
export type DisposeFn = () => void;

/**
 * Reaction options
 */
export interface ReactionOptions {
  /** Fire immediately */
  fireImmediately?: boolean;
  /** Delay in ms */
  delay?: number;
  /** Name for debugging */
  name?: string;
}

/**
 * Reactivity adapter interface
 *
 * Implement this interface to integrate with your preferred
 * state management library.
 */
export interface ReactivityAdapter {
  /**
   * Create an observable box (single value container)
   */
  createBox<T>(initialValue: T, options?: ObservableOptions): ObservableBox<T>;

  /**
   * Create an observable map
   */
  createMap<K, V>(
    entries?: Iterable<[K, V]>,
    options?: ObservableOptions
  ): ObservableMap<K, V>;

  /**
   * Create an observable array
   */
  createArray<T>(items?: T[], options?: ObservableOptions): ObservableArray<T>;

  /**
   * Make an object observable (deep by default)
   */
  makeObservable<T extends object>(target: T, options?: ObservableOptions): T;

  /**
   * Batch multiple updates into a single transaction
   */
  batch: BatchUpdateFn;

  /**
   * Run a function in an action context (for MobX strict mode)
   */
  runInAction<T>(fn: () => T): T;

  /**
   * Create a reaction that runs when observed values change
   */
  reaction<T>(
    expression: () => T,
    effect: (value: T) => void,
    options?: ReactionOptions
  ): DisposeFn;

  /**
   * Create a computed value
   */
  computed<T>(getter: () => T, options?: ObservableOptions): { get(): T };
}

/**
 * No-op reactivity adapter for non-reactive usage
 */
export const noopReactivityAdapter: ReactivityAdapter = {
  batch: (fn: () => void) => fn(),

  computed<T>(getter: () => T): { get(): T } {
    return { get: getter };
  },

  createArray<T>(items?: T[]): ObservableArray<T> {
    const arr = items ? [...items] : [];
    return {
      [Symbol.iterator]: () => arr[Symbol.iterator](),
      clear: () => {
        arr.length = 0;
      },
      filter: (predicate: (item: T) => boolean) => arr.filter(predicate),
      find: (predicate: (item: T) => boolean) => arr.find(predicate),
      get: (index: number) => arr[index],
      get length() {
        return arr.length;
      },
      map: <U>(mapper: (item: T) => U) => arr.map(mapper),
      pop: () => arr.pop(),
      push: (...newItems: T[]) => arr.push(...newItems),
      remove: (predicate: (item: T) => boolean) => {
        const removed: T[] = [];
        for (let i = arr.length - 1; i >= 0; i -= 1) {
          const item = arr[i];
          if (item !== undefined && predicate(item)) {
            removed.push(item);
            arr.splice(i, 1);
          }
        }
        return removed;
      },
      replace: (newItems: T[]) => {
        arr.length = 0;
        arr.push(...newItems);
      },
      toArray: () => [...arr],
    };
  },

  createBox<T>(initialValue: T): ObservableBox<T> {
    let value = initialValue;
    return {
      get: () => value,
      set: (v: T) => {
        value = v;
      },
    };
  },

  createMap<K, V>(entries?: Iterable<[K, V]>): ObservableMap<K, V> {
    const map = new Map<K, V>(entries);
    return {
      clear: () => map.clear(),
      delete: (key: K) => map.delete(key),
      entries: () => map.entries(),
      // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
      // oxlint-disable-next-line no-array-for-each
      // oxlint-disable-next-line prefer-await-to-callbacks
      // oxlint-disable-next-line no-array-for-each
      // oxlint-disable-next-line no-array-for-each, prefer-await-to-callbacks
      forEach: (cb) => map.forEach(cb),
      get: (key: K) => map.get(key),
      has: (key: K) => map.has(key),
      keys: () => map.keys(),
      set: (key: K, value: V) => {
        map.set(key, value);
      },
      get size() {
        return map.size;
      },
      values: () => map.values(),
    };
  },

  makeObservable<T extends object>(target: T): T {
    return target;
  },

  reaction<T>(
    _expression: () => T,
    _effect: (value: T) => void,
    _options?: ReactionOptions
  ): DisposeFn {
    return () => {
      // no-op
    };
  },

  runInAction<T>(fn: () => T): T {
    return fn();
  },
};
