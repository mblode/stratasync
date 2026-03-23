export type {
  BatchOperation,
  ModelPersistenceMeta,
  StorageAdapter,
  StorageIndexKey,
  StorageMeta,
  StorageOptions,
} from "@stratasync/client";

/**
 * Registry info stored in the workspace databases registry
 */
export interface DatabaseInfo {
  /** Workspace database name (e.g. ss_<hash>) */
  name: string;
  /** User ID used in name derivation */
  userId: string;
  /** Client version used in name derivation */
  version: number;
  /** Per-user version used in name derivation */
  userVersion: number;
  /** Schema hash for this database */
  schemaHash: string;
  /** Schema version used as the IndexedDB version */
  schemaVersion: number;
  /** Last update timestamp */
  updatedAt: number;
}

/**
 * Partial index entry for lazy hydration tracking
 */
export interface PartialIndexEntry {
  /** Model name */
  modelName: string;
  /** Indexed key used for hydration */
  indexedKey: string;
  /** Key value used for hydration */
  keyValue: string;
  /** Timestamp of last update */
  updatedAt?: number;
}
