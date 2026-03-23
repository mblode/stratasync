import type { SyncId } from "@stratasync/core";
import type { IDBPDatabase } from "idb";

import type { ModelPersistenceMeta, StorageMeta } from "../types.js";

/**
 * Store name for sync metadata
 */
export const META_STORE = "_meta";

/**
 * Key for the metadata record
 */
export const SYNC_META_KEY = "_metadata_";

/**
 * Default metadata values
 */
export const DEFAULT_META: StorageMeta = {
  bootstrapComplete: false,
  firstSyncId: "0",
  lastSyncId: "0",
  schemaHash: "",
  subscribedSyncGroups: [],
};

/** Normalizes a sync ID from storage, handling legacy numeric values */
const normalizeSyncIdValue = (value: unknown): SyncId => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return "0";
};

const normalizeMeta = (meta: StorageMeta): StorageMeta => ({
  ...DEFAULT_META,
  ...meta,
  firstSyncId: normalizeSyncIdValue(meta.firstSyncId),
  lastSyncId: normalizeSyncIdValue(meta.lastSyncId),
  subscribedSyncGroups:
    meta.subscribedSyncGroups ?? DEFAULT_META.subscribedSyncGroups,
});

type MetadataUpdates =
  | Partial<StorageMeta>
  | ((current: StorageMeta) => Partial<StorageMeta> | null);

const getMetadataRecord = async (
  db: IDBPDatabase
): Promise<StorageMeta | undefined> =>
  (await db.get(META_STORE, SYNC_META_KEY)) as StorageMeta | undefined;

const applyMetadataUpdate = async (
  db: IDBPDatabase,
  updates: MetadataUpdates,
  options?: { touchUpdatedAt?: boolean }
): Promise<StorageMeta> => {
  const tx = db.transaction(META_STORE, "readwrite");
  const store = tx.objectStore(META_STORE);
  const stored = (await store.get(SYNC_META_KEY)) as StorageMeta | undefined;
  const current = stored ? normalizeMeta(stored) : { ...DEFAULT_META };
  const resolvedUpdates =
    typeof updates === "function" ? updates(current) : updates;

  if (resolvedUpdates === null) {
    await tx.done;
    return current;
  }

  const updated: StorageMeta =
    options?.touchUpdatedAt === false
      ? {
          ...current,
          ...resolvedUpdates,
        }
      : {
          ...current,
          ...resolvedUpdates,
          updatedAt: Date.now(),
        };
  await store.put(normalizeMeta(updated), SYNC_META_KEY);
  await tx.done;
  return updated;
};

/**
 * Gets the sync metadata from the database
 */
export const getMetadata = async (db: IDBPDatabase): Promise<StorageMeta> => {
  const syncMeta = await getMetadataRecord(db);
  if (syncMeta) {
    return normalizeMeta(syncMeta);
  }

  return { ...DEFAULT_META };
};

/**
 * Sets the sync metadata in the database
 */
export const setMetadata = async (
  db: IDBPDatabase,
  meta: StorageMeta
): Promise<void> => {
  const normalized = normalizeMeta(meta);
  await db.put(META_STORE, normalized, SYNC_META_KEY);
};

/**
 * Updates specific fields in the metadata
 */
export const updateMetadata = (
  db: IDBPDatabase,
  updates: MetadataUpdates
): Promise<StorageMeta> => applyMetadataUpdate(db, updates);

export const mergeMetadata = (
  db: IDBPDatabase,
  updates: MetadataUpdates
): Promise<StorageMeta> =>
  applyMetadataUpdate(db, updates, { touchUpdatedAt: false });

/**
 * Adds a group to the subscribed groups
 */
export const addGroup = async (
  db: IDBPDatabase,
  groupId: string
): Promise<void> => {
  await updateMetadata(db, (current) => {
    const groups = current.subscribedSyncGroups ?? [];
    if (groups.includes(groupId)) {
      return null;
    }

    return {
      subscribedSyncGroups: [...groups, groupId],
    };
  });
};

/**
 * Removes a group from the subscribed groups
 */
export const removeGroup = async (
  db: IDBPDatabase,
  groupId: string
): Promise<void> => {
  await updateMetadata(db, (current) => {
    const groups = current.subscribedSyncGroups ?? [];
    const nextGroups = groups.filter((group) => group !== groupId);
    if (nextGroups.length === groups.length) {
      return null;
    }

    return {
      subscribedSyncGroups: nextGroups,
    };
  });
};

/**
 * Gets the persistence state for a model
 */
export const getModelPersistence = async (
  db: IDBPDatabase,
  modelName: string
): Promise<ModelPersistenceMeta> => {
  const record = await db.get(META_STORE, modelName);
  return (
    (record as ModelPersistenceMeta | undefined) ?? {
      modelName,
      persisted: false,
    }
  );
};

/**
 * Sets the persistence state for a model
 */
export const setModelPersistence = async (
  db: IDBPDatabase,
  modelName: string,
  persisted: boolean
): Promise<void> => {
  await db.put(
    META_STORE,
    {
      modelName,
      persisted,
      updatedAt: Date.now(),
    } satisfies ModelPersistenceMeta,
    modelName
  );
};

/**
 * Checks if all models are persisted
 */
export const areModelsPersisted = async (
  db: IDBPDatabase,
  modelNames: string[]
): Promise<boolean> => {
  for (const modelName of modelNames) {
    const record = await getModelPersistence(db, modelName);
    if (!record.persisted) {
      return false;
    }
  }
  return true;
};

/**
 * Sets the persistence state for multiple models
 */
export const setModelsPersisted = async (
  db: IDBPDatabase,
  modelNames: string[],
  persisted: boolean
): Promise<void> => {
  const tx = db.transaction(META_STORE, "readwrite");
  const store = tx.objectStore(META_STORE);

  for (const modelName of modelNames) {
    await store.put(
      {
        modelName,
        persisted,
        updatedAt: Date.now(),
      } satisfies ModelPersistenceMeta,
      modelName
    );
  }

  await tx.done;
};

/**
 * Seeds default metadata and model persistence records if they don't exist.
 * Runs in a single transaction for atomicity.
 */
export const initializeMetadata = async (
  db: IDBPDatabase,
  schemaHash: string,
  modelNames: string[]
): Promise<void> => {
  const tx = db.transaction(META_STORE, "readwrite");
  const store = tx.objectStore(META_STORE);

  const syncMeta = await store.get(SYNC_META_KEY);
  if (!syncMeta) {
    await store.put(
      {
        ...DEFAULT_META,
        schemaHash,
        updatedAt: Date.now(),
      } satisfies StorageMeta,
      SYNC_META_KEY
    );
  }

  for (const modelName of modelNames) {
    const existing = await store.get(modelName);
    if (!existing) {
      await store.put(
        {
          modelName,
          persisted: false,
          updatedAt: Date.now(),
        } satisfies ModelPersistenceMeta,
        modelName
      );
    }
  }

  await tx.done;
};
