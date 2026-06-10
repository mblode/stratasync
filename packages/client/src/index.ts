export { createSyncClient } from "./client.js";
export {
  isQuotaExceededError,
  StorageQuotaError,
  wrapQuotaErrors,
} from "./errors.js";
export type {
  BatchOperation,
  ModelPersistenceMeta,
  QueryOptions,
  QueryResult,
  StorageAdapter,
  StorageIndexKey,
  StorageMeta,
  StorageOptions,
  SyncClient,
  SyncClientEvent,
  TransportAdapter,
} from "./types.js";
