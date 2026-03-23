import type {
  BatchOperation,
  ModelPersistenceMeta,
  StorageAdapter,
  StorageIndexKey,
  StorageMeta,
  StorageOptions,
} from "@stratasync/client";
import { compareSyncId, isSyncIdGreaterThan } from "@stratasync/core";
import type { SyncAction, Transaction } from "@stratasync/core";

/**
 * Options for creating a localStorage adapter
 */
export interface LocalStorageOptions {
  /** Key prefix for all localStorage entries (default: "ss") */
  prefix?: string;
  /** Custom Storage implementation (defaults to globalThis.localStorage) */
  storage?: Storage;
}

/**
 * localStorage-backed StorageAdapter implementation.
 *
 * Stores all data as JSON strings in localStorage under namespaced keys.
 * Suitable for demos, lightweight apps, and environments without IndexedDB.
 */
export class LocalStorageAdapter implements StorageAdapter {
  private readonly prefix: string;
  private readonly backend: Storage;
  private dbName = "";

  constructor(options?: LocalStorageOptions) {
    this.prefix = options?.prefix ?? "ss";
    this.backend = options?.storage ?? globalThis.localStorage;
  }

  open(options: StorageOptions): Promise<void> {
    this.dbName = options.name ?? "default";
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.dbName = "";
    return Promise.resolve();
  }

  get<T>(modelName: string, id: string): Promise<T | null> {
    const store = this.readModelStore(modelName);
    const row = store[id];
    return Promise.resolve((row as T | undefined) ?? null);
  }

  getAll<T>(modelName: string): Promise<T[]> {
    const store = this.readModelStore(modelName);
    return Promise.resolve(Object.values(store) as T[]);
  }

  put<T extends Record<string, unknown>>(
    modelName: string,
    row: T
  ): Promise<void> {
    const { id } = row;
    if (typeof id !== "string") {
      throw new TypeError(`Missing id for model ${modelName}`);
    }
    const store = this.readModelStore(modelName);
    store[id] = { ...row };
    this.writeModelStore(modelName, store);
    return Promise.resolve();
  }

  delete(modelName: string, id: string): Promise<void> {
    const store = this.readModelStore(modelName);
    const { [id]: _, ...rest } = store;
    this.writeModelStore(modelName, rest);
    return Promise.resolve();
  }

  getByIndex<T>(
    modelName: string,
    indexName: string,
    key: StorageIndexKey
  ): Promise<T[]> {
    const store = this.readModelStore(modelName);
    const results: T[] = [];
    for (const row of Object.values(store)) {
      if (row[indexName] === key) {
        results.push(row as T);
      }
    }
    return Promise.resolve(results);
  }

  async writeBatch(ops: BatchOperation[]): Promise<void> {
    for (const op of ops) {
      if (op.type === "put" && op.data) {
        await this.put(op.modelName, op.data);
      } else if (op.type === "delete" && op.id) {
        await this.delete(op.modelName, op.id);
      }
    }
  }

  getMeta(): Promise<StorageMeta> {
    const raw = this.backend.getItem(this.key("meta"));
    if (!raw) {
      return Promise.resolve({ lastSyncId: "0" });
    }
    const meta = JSON.parse(raw) as StorageMeta;
    return Promise.resolve(meta);
  }

  setMeta(updates: Partial<StorageMeta>): Promise<void> {
    const raw = this.backend.getItem(this.key("meta"));
    const current: StorageMeta = raw
      ? (JSON.parse(raw) as StorageMeta)
      : { lastSyncId: "0" };

    const merged: StorageMeta = {
      ...current,
      ...updates,
      subscribedSyncGroups: Array.isArray(updates.subscribedSyncGroups)
        ? [...updates.subscribedSyncGroups]
        : current.subscribedSyncGroups,
    };

    this.backend.setItem(this.key("meta"), JSON.stringify(merged));
    return Promise.resolve();
  }

  getModelPersistence(modelName: string): Promise<ModelPersistenceMeta> {
    const raw = this.backend.getItem(this.key(`persistence:${modelName}`));
    if (!raw) {
      return Promise.resolve({ modelName, persisted: false });
    }
    return Promise.resolve(JSON.parse(raw) as ModelPersistenceMeta);
  }

  setModelPersistence(modelName: string, persisted: boolean): Promise<void> {
    const meta: ModelPersistenceMeta = {
      modelName,
      persisted,
      updatedAt: Date.now(),
    };
    this.backend.setItem(
      this.key(`persistence:${modelName}`),
      JSON.stringify(meta)
    );
    return Promise.resolve();
  }

  getOutbox(): Promise<Transaction[]> {
    const raw = this.backend.getItem(this.key("outbox"));
    if (!raw) {
      return Promise.resolve([]);
    }
    return Promise.resolve(JSON.parse(raw) as Transaction[]);
  }

  addToOutbox(tx: Transaction): Promise<void> {
    const outbox = this.readOutbox();
    outbox.push(tx);
    this.writeOutbox(outbox);
    return Promise.resolve();
  }

  removeFromOutbox(clientTxId: string): Promise<void> {
    const outbox = this.readOutbox();
    const filtered = outbox.filter((tx) => tx.clientTxId !== clientTxId);
    this.writeOutbox(filtered);
    return Promise.resolve();
  }

  updateOutboxTransaction(
    clientTxId: string,
    updates: Partial<Transaction>
  ): Promise<void> {
    const outbox = this.readOutbox();
    const tx = outbox.find((entry) => entry.clientTxId === clientTxId);
    if (tx) {
      Object.assign(tx, updates);
      this.writeOutbox(outbox);
    }
    return Promise.resolve();
  }

  hasPartialIndex(
    modelName: string,
    indexedKey: string,
    keyValue: string
  ): Promise<boolean> {
    const indexes = this.readPartialIndexes();
    return Promise.resolve(
      indexes.has(`${modelName}:${indexedKey}:${keyValue}`)
    );
  }

  setPartialIndex(
    modelName: string,
    indexedKey: string,
    keyValue: string
  ): Promise<void> {
    const indexes = this.readPartialIndexes();
    indexes.add(`${modelName}:${indexedKey}:${keyValue}`);
    this.writePartialIndexes(indexes);
    return Promise.resolve();
  }

  addSyncActions(actions: SyncAction[]): Promise<void> {
    if (actions.length === 0) {
      return Promise.resolve();
    }
    const existing = this.readSyncActions();
    existing.push(...actions);
    this.writeSyncActions(existing);
    return Promise.resolve();
  }

  getSyncActions(afterSyncId = "0", limit?: number): Promise<SyncAction[]> {
    const all = this.readSyncActions();
    const filtered = all
      .filter((action) => isSyncIdGreaterThan(action.id, afterSyncId))
      .toSorted((a, b) => compareSyncId(a.id, b.id));
    if (typeof limit === "number") {
      return Promise.resolve(filtered.slice(0, limit));
    }
    return Promise.resolve(filtered);
  }

  clearSyncActions(): Promise<void> {
    this.backend.removeItem(this.key("sync-actions"));
    return Promise.resolve();
  }

  clear(options?: { preserveOutbox?: boolean }): Promise<void> {
    const preserveOutbox = options?.preserveOutbox === true;
    let savedOutbox: Transaction[] = [];

    if (preserveOutbox) {
      savedOutbox = this.readOutbox();
    }

    // Remove all keys with our prefix + dbName
    const keysToRemove: string[] = [];
    const keyPrefix = `${this.prefix}:${this.dbName}:`;
    for (let i = 0; i < this.backend.length; i += 1) {
      const k = this.backend.key(i);
      if (k?.startsWith(keyPrefix)) {
        keysToRemove.push(k);
      }
    }
    for (const k of keysToRemove) {
      this.backend.removeItem(k);
    }

    if (preserveOutbox && savedOutbox.length > 0) {
      this.writeOutbox(savedOutbox);
    }

    return Promise.resolve();
  }

  count(modelName: string): Promise<number> {
    const store = this.readModelStore(modelName);
    return Promise.resolve(Object.keys(store).length);
  }

  // --- Private helpers ---

  private key(suffix: string): string {
    return `${this.prefix}:${this.dbName}:${suffix}`;
  }

  private readModelStore(
    modelName: string
  ): Record<string, Record<string, unknown>> {
    const raw = this.backend.getItem(this.key(`model:${modelName}`));
    if (!raw) {
      return {};
    }
    return JSON.parse(raw) as Record<string, Record<string, unknown>>;
  }

  private writeModelStore(
    modelName: string,
    store: Record<string, Record<string, unknown>>
  ): void {
    this.backend.setItem(this.key(`model:${modelName}`), JSON.stringify(store));
  }

  private readOutbox(): Transaction[] {
    const raw = this.backend.getItem(this.key("outbox"));
    if (!raw) {
      return [];
    }
    return JSON.parse(raw) as Transaction[];
  }

  private writeOutbox(outbox: Transaction[]): void {
    this.backend.setItem(this.key("outbox"), JSON.stringify(outbox));
  }

  private readPartialIndexes(): Set<string> {
    const raw = this.backend.getItem(this.key("partial"));
    if (!raw) {
      return new Set();
    }
    return new Set(JSON.parse(raw) as string[]);
  }

  private writePartialIndexes(indexes: Set<string>): void {
    this.backend.setItem(this.key("partial"), JSON.stringify([...indexes]));
  }

  private readSyncActions(): SyncAction[] {
    const raw = this.backend.getItem(this.key("sync-actions"));
    if (!raw) {
      return [];
    }
    return JSON.parse(raw) as SyncAction[];
  }

  private writeSyncActions(actions: SyncAction[]): void {
    this.backend.setItem(this.key("sync-actions"), JSON.stringify(actions));
  }
}

/**
 * Creates a localStorage storage adapter
 */
export const createLocalStorage = (
  options?: LocalStorageOptions
): StorageAdapter => new LocalStorageAdapter(options);
