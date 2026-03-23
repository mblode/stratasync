import type { IDBPDatabase } from "idb";

import type { PartialIndexEntry } from "../types.js";

/**
 * Store name for partial index tracking */
export const PARTIAL_INDEX_STORE = "partial_index";

/**
 * Creates a partial index key from indexedKey and keyValue */
export const createPartialIndexKey = (
  indexedKey: string,
  keyValue: string
): string => {
  if (indexedKey.includes(":")) {
    throw new Error(`Invalid partial index key: ${indexedKey}`);
  }

  return `${indexedKey}:${keyValue}`;
};

/**
 * Parses a partial index key into indexedKey and keyValue */
export const parsePartialIndexKey = (
  key: string
): {
  indexedKey: string;
  keyValue: string;
} => {
  const [indexedKey, ...rest] = key.split(":");
  return {
    indexedKey: indexedKey ?? key,
    keyValue: rest.join(":"),
  };
};

/**
 * Gets a partial index entry from the database */
export const getPartialIndex = async (
  db: IDBPDatabase,
  indexedKey: string,
  keyValue: string
): Promise<PartialIndexEntry | null> => {
  const key = createPartialIndexKey(indexedKey, keyValue);
  const result = await db.get(PARTIAL_INDEX_STORE, key);
  return (result as PartialIndexEntry | undefined) ?? null;
};

/**
 * Sets a partial index entry in the database */
export const setPartialIndex = async (
  db: IDBPDatabase,
  entry: PartialIndexEntry
): Promise<void> => {
  const key = createPartialIndexKey(entry.indexedKey, entry.keyValue);
  await db.put(
    PARTIAL_INDEX_STORE,
    {
      ...entry,
      updatedAt: entry.updatedAt ?? Date.now(),
    },
    key
  );
};

/**
 * Checks if a partial index key is present */
export const hasPartialIndex = async (
  db: IDBPDatabase,
  indexedKey: string,
  keyValue: string
): Promise<boolean> => {
  const key = createPartialIndexKey(indexedKey, keyValue);
  const result = await db.getKey(PARTIAL_INDEX_STORE, key);
  return result !== undefined;
};

/**
 * Gets all partial index entries */
export const getAllPartialIndexes = (
  db: IDBPDatabase
): Promise<PartialIndexEntry[]> =>
  db.getAll(PARTIAL_INDEX_STORE) as Promise<PartialIndexEntry[]>;

/**
 * Clears all partial index entries */
export const clearPartialIndexes = async (db: IDBPDatabase): Promise<void> => {
  const tx = db.transaction(PARTIAL_INDEX_STORE, "readwrite");
  await tx.objectStore(PARTIAL_INDEX_STORE).clear();
  await tx.done;
};
