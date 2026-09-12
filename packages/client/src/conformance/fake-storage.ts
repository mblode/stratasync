import type { SyncAction, SyncId, Transaction } from "@stratasync/core";

import type {
  BatchOperation,
  ClearStorageOptions,
  ModelPersistenceMeta,
  StorageAdapter,
  StorageIndexKey,
  StorageMeta,
  StorageOptions,
} from "../types.js";

/**
 * In-memory {@link StorageAdapter} for conformance runs. Plain maps, no
 * IndexedDB, no persistence across runs — the scenario's `given` block is the
 * only way state pre-exists.
 */
export class MemoryStorage implements StorageAdapter {
  private readonly rows = new Map<
    string,
    Map<string, Record<string, unknown>>
  >();
  private meta: StorageMeta = { lastSyncId: "0" };
  private readonly modelPersistence = new Map<string, boolean>();
  private outbox: Transaction[] = [];
  private readonly partialIndexes = new Set<string>();
  private syncActions: SyncAction[] = [];

  // oxlint-disable-next-line class-methods-use-this -- nothing to open: the maps are the store
  open(_options: StorageOptions): Promise<void> {
    return Promise.resolve();
  }

  // oxlint-disable-next-line class-methods-use-this -- nothing to close either
  close(): Promise<void> {
    return Promise.resolve();
  }

  private store(modelName: string): Map<string, Record<string, unknown>> {
    const existing = this.rows.get(modelName);
    if (existing) {
      return existing;
    }
    const created = new Map<string, Record<string, unknown>>();
    this.rows.set(modelName, created);
    return created;
  }

  private writeRow(modelName: string, row: Record<string, unknown>): void {
    const { id } = row;
    if (typeof id !== "string") {
      throw new TypeError(`Row for ${modelName} has no string id`);
    }
    this.store(modelName).set(id, { ...row });
  }

  get<T>(modelName: string, id: string): Promise<T | null> {
    return Promise.resolve(
      (this.rows.get(modelName)?.get(id) as T | undefined) ?? null
    );
  }

  getAll<T>(modelName: string): Promise<T[]> {
    return Promise.resolve([
      ...(this.rows.get(modelName)?.values() ?? []),
    ] as T[]);
  }

  put<T extends Record<string, unknown>>(
    modelName: string,
    row: T
  ): Promise<void> {
    this.writeRow(modelName, row);
    return Promise.resolve();
  }

  delete(modelName: string, id: string): Promise<void> {
    this.rows.get(modelName)?.delete(id);
    return Promise.resolve();
  }

  getByIndex<T>(
    modelName: string,
    indexName: string,
    key: StorageIndexKey
  ): Promise<T[]> {
    const matches = [...(this.rows.get(modelName)?.values() ?? [])].filter(
      (row) => row[indexName] === key
    );
    return Promise.resolve(matches as T[]);
  }

  writeBatch(ops: BatchOperation[]): Promise<void> {
    for (const op of ops) {
      if (op.type === "put" && op.data) {
        this.writeRow(op.modelName, op.data);
      } else if (op.type === "delete" && op.id) {
        this.rows.get(op.modelName)?.delete(op.id);
      }
    }
    return Promise.resolve();
  }

  getMeta(): Promise<StorageMeta> {
    return Promise.resolve({
      ...this.meta,
      subscribedSyncGroups: this.meta.subscribedSyncGroups
        ? [...this.meta.subscribedSyncGroups]
        : undefined,
    });
  }

  setMeta(meta: Partial<StorageMeta>): Promise<void> {
    this.meta = {
      ...this.meta,
      ...meta,
      subscribedSyncGroups: meta.subscribedSyncGroups
        ? [...meta.subscribedSyncGroups]
        : this.meta.subscribedSyncGroups,
    };
    return Promise.resolve();
  }

  getModelPersistence(modelName: string): Promise<ModelPersistenceMeta> {
    return Promise.resolve({
      modelName,
      persisted: this.modelPersistence.get(modelName) ?? false,
    });
  }

  setModelPersistence(modelName: string, persisted: boolean): Promise<void> {
    this.modelPersistence.set(modelName, persisted);
    return Promise.resolve();
  }

  getOutbox(): Promise<Transaction[]> {
    return Promise.resolve([...this.outbox]);
  }

  addToOutbox(tx: Transaction): Promise<void> {
    this.outbox.push({ ...tx });
    return Promise.resolve();
  }

  removeFromOutbox(clientTxId: string): Promise<void> {
    this.outbox = this.outbox.filter((tx) => tx.clientTxId !== clientTxId);
    return Promise.resolve();
  }

  updateOutboxTransaction(
    clientTxId: string,
    updates: Partial<Transaction>
  ): Promise<void> {
    const tx = this.outbox.find((entry) => entry.clientTxId === clientTxId);
    if (tx) {
      Object.assign(tx, updates);
    }
    return Promise.resolve();
  }

  hasPartialIndex(
    modelName: string,
    indexedKey: string,
    keyValue: string
  ): Promise<boolean> {
    return Promise.resolve(
      this.partialIndexes.has(`${modelName}:${indexedKey}:${keyValue}`)
    );
  }

  setPartialIndex(
    modelName: string,
    indexedKey: string,
    keyValue: string
  ): Promise<void> {
    this.partialIndexes.add(`${modelName}:${indexedKey}:${keyValue}`);
    return Promise.resolve();
  }

  addSyncActions(actions: SyncAction[]): Promise<void> {
    this.syncActions.push(...actions);
    return Promise.resolve();
  }

  getSyncActions(afterSyncId?: SyncId, limit?: number): Promise<SyncAction[]> {
    const filtered = afterSyncId
      ? this.syncActions.filter((action) => action.id > afterSyncId)
      : [...this.syncActions];
    return Promise.resolve(
      typeof limit === "number" ? filtered.slice(0, limit) : filtered
    );
  }

  clearSyncActions(): Promise<void> {
    this.syncActions = [];
    return Promise.resolve();
  }

  pruneSyncActions(beforeSyncId: SyncId): Promise<void> {
    this.syncActions = this.syncActions.filter(
      (action) => action.id > beforeSyncId
    );
    return Promise.resolve();
  }

  clear(options?: ClearStorageOptions): Promise<void> {
    const preserved = options?.preserveOutbox
      ? {
          clientId: this.meta.clientId,
          groupChangePending: this.meta.groupChangePending,
          privacyWithheldClientTxIds: this.meta.privacyWithheldClientTxIds,
          subscribedSyncGroups: this.meta.subscribedSyncGroups,
        }
      : {};
    this.rows.clear();
    this.modelPersistence.clear();
    if (!options?.preserveOutbox) {
      this.outbox = [];
    }
    this.partialIndexes.clear();
    this.syncActions = [];
    this.meta = { lastSyncId: "0", ...preserved };
    return Promise.resolve();
  }

  count(modelName: string): Promise<number> {
    return Promise.resolve(this.rows.get(modelName)?.size ?? 0);
  }
}
