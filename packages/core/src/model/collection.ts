import { ModelRegistry } from "../schema/registry.js";
import type { Model } from "./base-model.js";
import { CachedPromise } from "./cached-promise.js";

interface CollectionStore {
  get?: (modelName: string, id: string) => unknown | Promise<unknown>;
  getByIndex?: <T extends Record<string, unknown>>(
    modelName: string,
    indexName: string,
    key: string
  ) => Promise<T[]>;
  loadByIndex?: <T extends Record<string, unknown>>(
    modelName: string,
    indexName: string,
    key: string
  ) => Promise<T[]>;
}

interface CollectionContext {
  modelName?: string;
  foreignKey?: string;
}

interface InferredRelation {
  modelName: string;
  foreignKey: string;
}

const inferredCollectionRelationCache = new Map<
  string,
  InferredRelation | null
>();

const inferCollectionRelation = (
  ownerModelName: string,
  propertyName: string
): InferredRelation | null => {
  const cacheKey = `${ModelRegistry.getSchemaHash()}:${ownerModelName}:${propertyName}`;
  const cached = inferredCollectionRelationCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  for (const modelName of ModelRegistry.getModelNames()) {
    const properties = ModelRegistry.getModelProperties(modelName);
    for (const meta of properties.values()) {
      if (
        meta.inverseProperty === propertyName &&
        meta.referenceModel === ownerModelName &&
        meta.foreignKey
      ) {
        const inferred = { foreignKey: meta.foreignKey, modelName };
        inferredCollectionRelationCache.set(cacheKey, inferred);
        return inferred;
      }
    }
  }

  inferredCollectionRelationCache.set(cacheKey, null);
  return null;
};

export class LazyCollection<T extends Model> {
  private elementsCache: T[] = [];
  private hydrated = false;
  private hydrating?: CachedPromise<T[]>;
  private owner?: Model;
  private propertyName?: string;
  private modelName?: string;
  private foreignKey?: string;
  private attached = false;

  constructor(items?: Iterable<T>) {
    if (items !== undefined) {
      this.elementsCache = [...items];
      this.hydrated = true;
    }
  }

  attach(
    owner: Model,
    propertyName: string,
    context: CollectionContext = {}
  ): void {
    if (
      this.attached &&
      this.owner === owner &&
      this.propertyName === propertyName
    ) {
      return;
    }

    this.owner = owner;
    this.propertyName = propertyName;
    this.modelName = context.modelName ?? this.modelName;
    this.foreignKey = context.foreignKey ?? this.foreignKey;

    if (!(this.modelName && this.foreignKey)) {
      const ownerModelName = owner.__modelName;
      const inferred = inferCollectionRelation(ownerModelName, propertyName);
      if (inferred) {
        this.modelName = this.modelName ?? inferred.modelName;
        this.foreignKey = this.foreignKey ?? inferred.foreignKey;
      }
    }

    this.attached = true;
  }

  private ensureHydrating(): void {
    if (this.hydrated || this.hydrating) {
      return;
    }
    // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
    this.hydrate().catch(() => {
      /* noop */
    });
  }

  get elements(): T[] {
    this.ensureHydrating();
    return this.elementsCache;
  }

  get length(): number {
    this.ensureHydrating();
    return this.elementsCache.length;
  }

  map<U>(
    callback: (value: T, index: number, array: T[]) => U,
    thisArg?: unknown
  ): U[] {
    this.ensureHydrating();
    // oxlint-disable-next-line no-array-method-this-argument
    return this.elementsCache.map(callback, thisArg);
  }

  filter(
    callback: (value: T, index: number, array: T[]) => boolean,
    thisArg?: unknown
  ): T[] {
    this.ensureHydrating();
    // oxlint-disable-next-line no-array-method-this-argument
    return this.elementsCache.filter(callback, thisArg);
  }

  find(
    callback: (value: T, index: number, array: T[]) => boolean,
    thisArg?: unknown
    // oxlint-disable-next-line no-array-method-this-argument
  ): T | undefined {
    this.ensureHydrating();
    // oxlint-disable-next-line no-array-method-this-argument
    return this.elementsCache.find(callback, thisArg);
  }

  every(
    callback: (value: T, index: number, array: T[]) => boolean,
    // oxlint-disable-next-line no-array-method-this-argument
    thisArg?: unknown
  ): boolean {
    this.ensureHydrating();
    // oxlint-disable-next-line no-array-method-this-argument
    return this.elementsCache.every(callback, thisArg);
  }

  add(item: T): void {
    this.ensureHydrating();
    this.elementsCache.push(item);
  }

  remove(item: T): boolean {
    this.ensureHydrating();
    const index = this.elementsCache.indexOf(item);
    if (index === -1) {
      return false;
    }
    this.elementsCache.splice(index, 1);
    return true;
  }

  clear(): void {
    this.ensureHydrating();
    this.elementsCache = [];
    this.hydrated = true;
  }

  toArray(): T[] {
    this.ensureHydrating();
    return [...this.elementsCache];
  }

  [Symbol.iterator](): IterableIterator<T> {
    this.ensureHydrating();
    return this.elementsCache[Symbol.iterator]();
  }

  hydrate(): Promise<T[]> {
    if (this.hydrated) {
      return Promise.resolve(this.elementsCache);
    }
    if (this.hydrating) {
      return this.hydrating.getPromise();
    }
    if (!(this.owner && this.modelName && this.foreignKey)) {
      return Promise.resolve(this.elementsCache);
    }

    const promise = (async () => {
      try {
        const items = await this.loadElements();
        this.elementsCache = items;
        this.hydrated = true;
        return items;
      } catch (error) {
        this.hydrating = undefined;
        throw error;
      }
    })();

    const cached = new CachedPromise(promise);
    this.hydrating = cached;
    return cached.getPromise();
  }

  private async loadElements(): Promise<T[]> {
    const { owner, modelName, foreignKey } = this;
    if (!(owner && modelName && foreignKey)) {
      return this.elementsCache;
    }

    const store = owner.store as CollectionStore | undefined;
    const ownerId = owner.id;
    const loadByIndex = store?.loadByIndex ?? store?.getByIndex;
    if (!(store && ownerId && loadByIndex)) {
      return this.elementsCache;
    }

    const rows = await loadByIndex<Record<string, unknown>>(
      modelName,
      foreignKey,
      ownerId
    );

    const ids = rows
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string");

    if (!store.get) {
      // oxlint-disable-next-line no-return-wrap
      return rows as unknown as T[];
    }

    // oxlint-disable-next-line prefer-native-coercion-functions
    // oxlint-disable-next-line no-return-wrap
    const items = await Promise.all(
      // oxlint-disable-next-line no-return-wrap
      ids.map((id) => Promise.resolve(store.get?.(modelName, id)))
    );

    // oxlint-disable-next-line prefer-native-coercion-functions
    return items.filter((item): item is T => Boolean(item));
  }
}
