import {
  compareSyncId,
  isSyncIdGreaterThan,
  ModelRegistry,
} from "@stratasync/core";
import type { SyncAction, Transaction } from "@stratasync/core";
import { openDB } from "idb";
import type { IDBPDatabase, DBSchema as IDBSchema } from "idb";

import { DatabaseManager } from "./database-manager.js";
import {
  computeModelStoreName,
  computePartialDatabaseName,
  computeWorkspaceDatabaseName,
} from "./store-names.js";
import {
  createPartialIndexKey,
  PARTIAL_INDEX_STORE,
} from "./stores/coverage.js";
import {
  getMetadata,
  getModelPersistence as getModelPersistenceMeta,
  initializeMetadata,
  mergeMetadata,
  META_STORE,
  setModelPersistence as setModelPersistenceMeta,
} from "./stores/meta.js";
import {
  addTransaction,
  getAllTransactions,
  removeTransaction,
  SYNC_ACTION_STORE,
  TRANSACTION_STORE,
  updateTransaction,
} from "./stores/outbox.js";
import type {
  BatchOperation,
  DatabaseInfo,
  ModelPersistenceMeta,
  PartialIndexEntry,
  StorageAdapter,
  StorageIndexKey,
  StorageMeta,
  StorageOptions,
} from "./types.js";

/**
 * IndexedDB database schema interface
 */
type DynamicStoreValue =
  | StorageMeta
  | ModelPersistenceMeta
  | Transaction
  | SyncAction
  | Record<string, unknown>;

interface SyncDBSchema extends IDBSchema {
  _meta: {
    key: string;
    value: StorageMeta | ModelPersistenceMeta;
  };
  _transaction: {
    key: string;
    value: Transaction;
    indexes: {
      byState: string;
      byCreatedAt: number;
      byBatchIndex: number;
    };
  };
  _sync_action: {
    key: string;
    value: SyncAction;
  };
  [key: string]: {
    key: string | number;
    value: DynamicStoreValue;
    indexes?: Record<string, string | number>;
  };
}

interface PartialIndexDBSchema extends IDBSchema {
  partial_index: {
    key: string;
    value: PartialIndexEntry;
  };
}

type StoreHandle = ReturnType<IDBPDatabase<unknown>["createObjectStore"]>;
type RegistryModel = ReturnType<ModelRegistry["getAllModels"]>[number];
interface StoreLayoutHandle {
  index: (name: string) => {
    keyPath: string | string[] | null;
    unique: boolean;
  };
  indexNames: DOMStringList;
  keyPath: string | string[] | null;
}

/**
 * IndexedDB storage adapter implementation
 */
export class IndexedDbStorageAdapter implements StorageAdapter {
  private db: IDBPDatabase<unknown> | null = null;
  private registry: ModelRegistry | null = null;
  private dbName = "";
  private schemaVersion = 1;
  private schemaHash = "";
  private readonly storeNames = new Map<string, string>();
  private readonly partialDbs = new Map<
    string,
    IDBPDatabase<PartialIndexDBSchema>
  >();
  private readonly partialDbPromises = new Map<
    string,
    Promise<IDBPDatabase<PartialIndexDBSchema>>
  >();
  private readonly databaseManager = new DatabaseManager();

  async open(options: StorageOptions): Promise<void> {
    await this.close();
    this.initializeRegistry(options);

    const userId = options.userId ?? "anonymous";
    const version = options.version ?? 1;
    const userVersion = options.userVersion ?? 1;
    this.dbName =
      options.name ??
      computeWorkspaceDatabaseName({ userId, userVersion, version });

    await this.databaseManager.open();

    const existingInfo = await this.databaseManager.getDatabaseInfo(
      this.dbName
    );
    this.schemaVersion = this.resolveSchemaVersion(existingInfo);
    this.populateStoreNames();

    await this.openDatabase();
    await this.syncDatabaseInfo(existingInfo, { userId, userVersion, version });
    await this.ensureMetadataInitialized();
    await this.openPartialDatabases();
  }

  private initializeRegistry(options: StorageOptions): void {
    this.registry = new ModelRegistry(
      options.schema ?? ModelRegistry.snapshot()
    );
    this.schemaHash = this.registry.getSchemaHash();
  }

  private resolveSchemaVersion(existingInfo: DatabaseInfo | null): number {
    if (!existingInfo) {
      return 1;
    }
    return existingInfo.schemaHash === this.schemaHash
      ? existingInfo.schemaVersion
      : existingInfo.schemaVersion + 1;
  }

  private populateStoreNames(): void {
    this.storeNames.clear();
    if (!this.registry) {
      return;
    }

    for (const model of this.registry.getAllModels()) {
      const modelName = model.name ?? "";
      if (!modelName) {
        continue;
      }
      this.storeNames.set(
        modelName,
        computeModelStoreName(modelName, this.schemaVersion, this.registry)
      );
    }
  }

  private async openDatabase(): Promise<void> {
    let includeBlockingHandlers = true;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let opened: IDBPDatabase<unknown>;

      try {
        opened = await this.openDatabaseWithSchemaVersion(
          this.schemaVersion,
          includeBlockingHandlers
        );
      } catch (error) {
        if (!IndexedDbStorageAdapter.isVersionError(error)) {
          throw error;
        }

        const existingVersion = await this.getExistingDatabaseVersion();
        this.schemaVersion = existingVersion + 1;
        this.populateStoreNames();
        includeBlockingHandlers = false;
        continue;
      }

      if (this.databaseHasExpectedLayout(opened)) {
        this.db = opened;
        return;
      }

      const nextSchemaVersion = opened.version + 1;
      opened.close();
      this.schemaVersion = nextSchemaVersion;
      this.populateStoreNames();
      includeBlockingHandlers = false;
    }

    throw new Error("Failed to open database with expected schema layout.");
  }

  private async openDatabaseWithSchemaVersion(
    schemaVersion: number,
    includeBlockingHandlers: boolean
  ): Promise<IDBPDatabase<unknown>> {
    const baseOptions = {
      upgrade: (database: IDBPDatabase<SyncDBSchema>) => {
        this.upgradeDatabase(database);
      },
    };

    if (!includeBlockingHandlers) {
      return (await openDB<SyncDBSchema>(
        this.dbName,
        schemaVersion,
        baseOptions
      )) as IDBPDatabase<unknown>;
    }

    return (await openDB<SyncDBSchema>(this.dbName, schemaVersion, {
      ...baseOptions,
      blocked: () => {
        // Another tab has the database open with an older version
      },
      blocking: () => {
        // This connection is blocking an upgrade in another tab
        this.db?.close();
        this.db = null;
      },
    })) as IDBPDatabase<unknown>;
  }

  private static isVersionError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "VersionError";
  }

  private async getExistingDatabaseVersion(): Promise<number> {
    const existing = await openDB<SyncDBSchema>(this.dbName);
    const existingVersion = existing.version;
    existing.close();
    return existingVersion;
  }

  private async syncDatabaseInfo(
    existingInfo: DatabaseInfo | null,
    context: { userId: string; version: number; userVersion: number }
  ): Promise<void> {
    const now = Date.now();
    if (!existingInfo) {
      await this.databaseManager.saveDatabase({
        name: this.dbName,
        schemaHash: this.schemaHash,
        schemaVersion: this.schemaVersion,
        updatedAt: now,
        userId: context.userId,
        userVersion: context.userVersion,
        version: context.version,
      });
      return;
    }

    if (
      existingInfo.schemaHash !== this.schemaHash ||
      existingInfo.schemaVersion !== this.schemaVersion
    ) {
      await this.databaseManager.saveDatabase({
        ...existingInfo,
        schemaHash: this.schemaHash,
        schemaVersion: this.schemaVersion,
        updatedAt: now,
      });
    }
  }

  private upgradeDatabase(db: IDBPDatabase<SyncDBSchema>): void {
    IndexedDbStorageAdapter.ensureMetaStore(db);
    IndexedDbStorageAdapter.ensureTransactionStore(db);
    IndexedDbStorageAdapter.ensureSyncActionStore(db);
    this.ensureModelStores(db as IDBPDatabase<unknown>);
  }

  private static ensureMetaStore(db: IDBPDatabase<SyncDBSchema>): void {
    if (db.objectStoreNames.contains(META_STORE)) {
      return;
    }
    db.createObjectStore(META_STORE);
  }

  private static ensureTransactionStore(db: IDBPDatabase<SyncDBSchema>): void {
    if (db.objectStoreNames.contains(TRANSACTION_STORE)) {
      return;
    }
    const txStore = db.createObjectStore(TRANSACTION_STORE, {
      keyPath: "clientTxId",
    });
    txStore.createIndex("byState", "state");
    txStore.createIndex("byCreatedAt", "createdAt");
    txStore.createIndex("byBatchIndex", "batchIndex");
  }

  private static ensureSyncActionStore(db: IDBPDatabase<SyncDBSchema>): void {
    if (db.objectStoreNames.contains(SYNC_ACTION_STORE)) {
      return;
    }
    db.createObjectStore(SYNC_ACTION_STORE, { keyPath: "id" });
  }

  private ensureModelStores(db: IDBPDatabase<unknown>): void {
    if (!this.registry) {
      return;
    }

    for (const model of this.registry.getAllModels()) {
      const modelName = model.name ?? "";
      if (!modelName) {
        continue;
      }
      const storeName = this.storeNames.get(modelName);
      if (!storeName) {
        continue;
      }
      if (db.objectStoreNames.contains(storeName)) {
        continue;
      }
      IndexedDbStorageAdapter.createModelStore(db, storeName, model);
    }
  }

  private static createModelStore(
    db: IDBPDatabase<unknown>,
    storeName: string,
    model: RegistryModel
  ): void {
    const primaryKey = model.primaryKey ?? "id";
    const store = db.createObjectStore(storeName, { keyPath: primaryKey });
    IndexedDbStorageAdapter.createFieldIndexes(store, model);
    IndexedDbStorageAdapter.createRelationIndexes(store, model);
    IndexedDbStorageAdapter.createGroupIndex(store, model);
    IndexedDbStorageAdapter.createModelIndexes(store, model);
  }

  private static createFieldIndexes(
    store: StoreHandle,
    model: RegistryModel
  ): void {
    for (const [fieldName, field] of Object.entries(model.fields ?? {})) {
      if (field.indexed) {
        store.createIndex(fieldName, fieldName);
      }
    }
  }

  private static createRelationIndexes(
    store: StoreHandle,
    model: RegistryModel
  ): void {
    for (const [relationName, relation] of Object.entries(
      model.relations ?? {}
    )) {
      if (!relation.indexed) {
        continue;
      }

      const indexName = relation.foreignKey ?? relationName;
      if (!store.indexNames.contains(indexName)) {
        store.createIndex(indexName, indexName);
      }
    }
  }

  private static createGroupIndex(
    store: StoreHandle,
    model: RegistryModel
  ): void {
    if (!model.groupKey) {
      return;
    }
    if (!store.indexNames.contains(model.groupKey)) {
      store.createIndex(model.groupKey, model.groupKey);
    }
  }

  private static createModelIndexes(
    store: StoreHandle,
    model: RegistryModel
  ): void {
    for (const index of model.indexes ?? []) {
      const indexName = index.fields.join("_");
      if (!store.indexNames.contains(indexName)) {
        store.createIndex(indexName, index.fields, {
          unique: index.unique,
        });
      }
    }
  }

  private static getExpectedIndexes(model: RegistryModel): {
    keyPath: string | string[];
    name: string;
    unique: boolean;
  }[] {
    const indexes = new Map<
      string,
      { keyPath: string | string[]; name: string; unique: boolean }
    >();

    for (const [fieldName, field] of Object.entries(model.fields ?? {})) {
      if (field.indexed) {
        indexes.set(fieldName, {
          keyPath: fieldName,
          name: fieldName,
          unique: false,
        });
      }
    }

    for (const [relationName, relation] of Object.entries(
      model.relations ?? {}
    )) {
      if (relation.indexed) {
        const indexName = relation.foreignKey ?? relationName;
        indexes.set(indexName, {
          keyPath: indexName,
          name: indexName,
          unique: false,
        });
      }
    }

    if (model.groupKey) {
      indexes.set(model.groupKey, {
        keyPath: model.groupKey,
        name: model.groupKey,
        unique: false,
      });
    }

    for (const index of model.indexes ?? []) {
      const name = index.fields.join("_");
      indexes.set(name, {
        keyPath: index.fields,
        name,
        unique: index.unique ?? false,
      });
    }

    return [...indexes.values()];
  }

  private static normalizeKeyPath(
    keyPath: string | string[] | null
  ): string | null {
    if (Array.isArray(keyPath)) {
      return keyPath.join(",");
    }
    return keyPath;
  }

  private databaseHasExpectedLayout(db: IDBPDatabase<unknown>): boolean {
    if (
      !db.objectStoreNames.contains(META_STORE) ||
      !db.objectStoreNames.contains(TRANSACTION_STORE) ||
      !db.objectStoreNames.contains(SYNC_ACTION_STORE)
    ) {
      return false;
    }

    if (!this.registry) {
      return true;
    }

    for (const model of this.registry.getAllModels()) {
      const modelName = model.name ?? "";
      if (!modelName) {
        continue;
      }

      const storeName = this.storeNames.get(modelName);
      if (!storeName || !db.objectStoreNames.contains(storeName)) {
        return false;
      }

      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName) as StoreLayoutHandle;
      const expectedKeyPath = model.primaryKey ?? "id";
      const actualKeyPath = IndexedDbStorageAdapter.normalizeKeyPath(
        store.keyPath
      );

      if (actualKeyPath !== expectedKeyPath) {
        return false;
      }

      for (const expectedIndex of IndexedDbStorageAdapter.getExpectedIndexes(
        model
      )) {
        if (!store.indexNames.contains(expectedIndex.name)) {
          return false;
        }

        const actualIndex = store.index(expectedIndex.name);
        const actualIndexKeyPath = IndexedDbStorageAdapter.normalizeKeyPath(
          actualIndex.keyPath
        );
        const expectedIndexKeyPath = IndexedDbStorageAdapter.normalizeKeyPath(
          expectedIndex.keyPath
        );

        if (
          actualIndexKeyPath !== expectedIndexKeyPath ||
          actualIndex.unique !== expectedIndex.unique
        ) {
          return false;
        }
      }
    }

    return true;
  }

  close(): Promise<void> {
    for (const db of this.partialDbs.values()) {
      db.close();
    }
    this.partialDbs.clear();
    this.partialDbPromises.clear();

    this.databaseManager.close();
    this.db?.close();
    this.resetState();
    return Promise.resolve();
  }

  async get<T>(modelName: string, id: string): Promise<T | null> {
    const db = this.ensureOpen();
    const storeName = this.getStoreName(modelName);
    const result = await db.get(storeName, id);
    return (result as T | undefined) ?? null;
  }

  getAll<T>(modelName: string): Promise<T[]> {
    const db = this.ensureOpen();
    const storeName = this.getStoreName(modelName);
    return db.getAll(storeName) as Promise<T[]>;
  }

  async put<T extends Record<string, unknown>>(
    modelName: string,
    row: T
  ): Promise<void> {
    const db = this.ensureOpen();
    const storeName = this.getStoreName(modelName);
    await db.put(storeName, row);
  }

  async delete(modelName: string, id: string): Promise<void> {
    const db = this.ensureOpen();
    const storeName = this.getStoreName(modelName);
    await db.delete(storeName, id);
  }

  getByIndex<T>(
    modelName: string,
    indexName: string,
    key: StorageIndexKey
  ): Promise<T[]> {
    const db = this.ensureOpen();
    const storeName = this.getStoreName(modelName);
    return db.getAllFromIndex(storeName, indexName, key) as Promise<T[]>;
  }

  async writeBatch(ops: BatchOperation[]): Promise<void> {
    const db = this.ensureOpen();
    if (ops.length === 0) {
      return;
    }

    const tx = db.transaction(
      ops.map((op) => this.getStoreName(op.modelName)),
      "readwrite"
    );

    const promises: Promise<unknown>[] = [];

    for (const op of ops) {
      const storeName = this.getStoreName(op.modelName);
      const store = tx.objectStore(storeName);

      if (op.type === "put" && op.data) {
        promises.push(store.put(op.data));
      } else if (op.type === "delete" && op.id) {
        promises.push(store.delete(op.id));
      }
    }

    await Promise.all([...promises, tx.done]);
  }

  getMeta(): Promise<StorageMeta> {
    const db = this.ensureOpen();
    return getMetadata(db);
  }

  async setMeta(updates: Partial<StorageMeta>): Promise<void> {
    const db = this.ensureOpen();
    await mergeMetadata(db, (current) => ({
      ...updates,
      schemaHash: updates.schemaHash ?? (current.schemaHash || this.schemaHash),
    }));
  }

  getModelPersistence(modelName: string): Promise<ModelPersistenceMeta> {
    const db = this.ensureOpen();
    return getModelPersistenceMeta(db, modelName);
  }

  async setModelPersistence(
    modelName: string,
    persisted: boolean
  ): Promise<void> {
    const db = this.ensureOpen();
    await setModelPersistenceMeta(db, modelName, persisted);
  }

  getOutbox(): Promise<Transaction[]> {
    const db = this.ensureOpen();
    return getAllTransactions(db);
  }

  async addToOutbox(tx: Transaction): Promise<void> {
    const db = this.ensureOpen();
    await addTransaction(db, tx);
  }

  async removeFromOutbox(clientTxId: string): Promise<void> {
    const db = this.ensureOpen();
    await removeTransaction(db, clientTxId);
  }

  async updateOutboxTransaction(
    clientTxId: string,
    updates: Partial<Transaction>
  ): Promise<void> {
    const db = this.ensureOpen();
    await updateTransaction(db, clientTxId, updates);
  }

  async hasPartialIndex(
    modelName: string,
    indexedKey: string,
    keyValue: string
  ): Promise<boolean> {
    this.ensureOpen();
    const db = await this.getPartialDb(modelName);

    const key = createPartialIndexKey(indexedKey, keyValue);
    const result = await db.getKey(PARTIAL_INDEX_STORE, key);
    return result !== undefined;
  }

  async setPartialIndex(
    modelName: string,
    indexedKey: string,
    keyValue: string
  ): Promise<void> {
    this.ensureOpen();
    const db = await this.getPartialDb(modelName);
    const key = createPartialIndexKey(indexedKey, keyValue);
    await db.put(
      PARTIAL_INDEX_STORE,
      {
        indexedKey,
        keyValue,
        modelName,
        updatedAt: Date.now(),
      } satisfies PartialIndexEntry,
      key
    );
  }

  async addSyncActions(actions: SyncAction[]): Promise<void> {
    const db = this.ensureOpen();
    if (actions.length === 0) {
      return;
    }
    if (!db.objectStoreNames.contains(SYNC_ACTION_STORE)) {
      return;
    }
    const tx = db.transaction(SYNC_ACTION_STORE, "readwrite");
    const store = tx.objectStore(SYNC_ACTION_STORE);
    const writes: Promise<unknown>[] = [];
    for (const action of actions) {
      writes.push(store.put(action));
    }
    await Promise.all([...writes, tx.done]);
  }

  async getSyncActions(
    afterSyncId = "0",
    limit?: number
  ): Promise<SyncAction[]> {
    const db = this.ensureOpen();
    if (!db.objectStoreNames.contains(SYNC_ACTION_STORE)) {
      return [];
    }
    const all = (await db.getAll(SYNC_ACTION_STORE)) as SyncAction[];
    const filtered = all
      .filter((action) => isSyncIdGreaterThan(action.id, afterSyncId))
      .toSorted((a, b) => compareSyncId(a.id, b.id));
    if (typeof limit === "number") {
      return filtered.slice(0, limit);
    }
    return filtered;
  }

  async clearSyncActions(): Promise<void> {
    const db = this.ensureOpen();
    if (!db.objectStoreNames.contains(SYNC_ACTION_STORE)) {
      return;
    }
    const tx = db.transaction(SYNC_ACTION_STORE, "readwrite");
    await tx.objectStore(SYNC_ACTION_STORE).clear();
    await tx.done;
  }

  async clear(options?: { preserveOutbox?: boolean }): Promise<void> {
    const db = this.ensureOpen();
    const preserveOutbox = options?.preserveOutbox === true;

    for (const partialDb of this.partialDbs.values()) {
      const partialTx = partialDb.transaction(PARTIAL_INDEX_STORE, "readwrite");
      await partialTx.objectStore(PARTIAL_INDEX_STORE).clear();
      await partialTx.done;
    }

    const storeNames = [
      META_STORE,
      SYNC_ACTION_STORE,
      // oxlint-disable-next-line no-useless-spread
      ...[...this.storeNames.values()],
    ];
    if (!preserveOutbox) {
      storeNames.push(TRANSACTION_STORE);
    }

    const existing = storeNames.filter((store) =>
      db.objectStoreNames.contains(store)
    );

    const tx = db.transaction(existing, "readwrite");
    const promises: Promise<void>[] = [];

    for (const storeName of existing) {
      promises.push(tx.objectStore(storeName).clear());
    }

    await Promise.all([...promises, tx.done]);
  }

  count(modelName: string): Promise<number> {
    const db = this.ensureOpen();
    const storeName = this.getStoreName(modelName);
    return db.count(storeName);
  }

  private ensureOpen(): IDBPDatabase<unknown> {
    if (!this.db) {
      throw new Error("Database not open. Call open() first.");
    }
    return this.db;
  }

  private resetState(): void {
    this.db = null;
    this.registry = null;
    this.dbName = "";
    this.schemaVersion = 1;
    this.schemaHash = "";
    this.storeNames.clear();
    this.partialDbPromises.clear();
  }

  private getStoreName(modelName: string): string {
    const storeName = this.storeNames.get(modelName);
    if (storeName && this.db?.objectStoreNames.contains(storeName)) {
      return storeName;
    }

    throw new Error(`Unknown model store: ${modelName}`);
  }

  private async ensureMetadataInitialized(): Promise<void> {
    const db = this.ensureOpen();

    const modelNames = this.registry
      ? this.registry
          .getAllModels()
          .map((m) => m.name ?? "")
          .filter(Boolean)
      : [];

    await initializeMetadata(db, this.schemaHash, modelNames);

    const meta = await getMetadata(db);
    const storedHash = meta.schemaHash ?? "";
    const hashMatches = storedHash.length > 0 && storedHash === this.schemaHash;

    if (meta.bootstrapComplete && hashMatches && this.registry) {
      for (const model of this.registry.getBootstrapModels()) {
        const modelName = model.name ?? "";
        if (!modelName) {
          continue;
        }
        await this.setModelPersistence(modelName, true);
      }
    }
  }

  private async openPartialDatabases(): Promise<void> {
    if (!this.registry) {
      return;
    }

    for (const model of this.registry.getPartialModels()) {
      const modelName = model.name ?? "";
      if (!modelName) {
        continue;
      }
      await this.getPartialDb(modelName);
    }
  }

  private getPartialDb(
    modelName: string
  ): Promise<IDBPDatabase<PartialIndexDBSchema>> {
    const existing = this.partialDbs.get(modelName);
    if (existing) {
      return Promise.resolve(existing);
    }

    const pending = this.partialDbPromises.get(modelName);
    if (pending) {
      return pending;
    }

    const storeName = this.storeNames.get(modelName);
    if (!storeName) {
      throw new Error(`Unknown model store: ${modelName}`);
    }

    const dbName = computePartialDatabaseName({
      storeName,
      workspaceDatabaseName: this.dbName,
    });

    const openPromise = (async (): Promise<
      IDBPDatabase<PartialIndexDBSchema>
    > => {
      try {
        const db = await openDB<PartialIndexDBSchema>(dbName, 1, {
          upgrade: (database) => {
            if (!database.objectStoreNames.contains(PARTIAL_INDEX_STORE)) {
              database.createObjectStore(PARTIAL_INDEX_STORE);
            }
          },
        });
        this.partialDbs.set(modelName, db);
        return db;
      } finally {
        this.partialDbPromises.delete(modelName);
      }
    })();

    this.partialDbPromises.set(modelName, openPromise);
    return openPromise;
  }
}

/**
 * Creates an IndexedDB storage adapter
 */
export const createIndexedDbStorage = (): StorageAdapter =>
  new IndexedDbStorageAdapter();
