import type { StorageAdapter } from "@stratasync/client";
import type {
  ModelRegistrySnapshot,
  ModelRow,
  SchemaDefinition,
  SyncId,
} from "@stratasync/core";

export interface BootstrapSnapshot {
  version: 1;
  schemaHash: string;
  lastSyncId: SyncId;
  firstSyncId?: SyncId;
  groups: string[];
  rows: ModelRow[];
  fetchedAt: number;
  rowCount?: number;
}

export interface BootstrapSnapshotPayload {
  version: 1;
  encoding: "json" | "gzip-base64";
  data: string;
}

export interface PrefetchBootstrapOptions {
  endpoint: string;
  authorization?: string;
  headers?: Record<string, string>;
  models?: string[];
  groups?: string[];
  schemaHash?: string;
  timeout?: number;
}

export interface SerializeBootstrapOptions {
  compress?: boolean;
}

export interface SeedStorageOptions {
  storage: StorageAdapter;
  snapshot: BootstrapSnapshot | BootstrapSnapshotPayload | string;
  dbName?: string;
  clearExisting?: boolean;
  validateSchemaHash?: boolean;
  batchSize?: number;
  closeAfter?: boolean;
  schema?: SchemaDefinition | ModelRegistrySnapshot;
}

export interface SeedStorageResult {
  applied: boolean;
  rowCount: number;
  reason?: "schema_mismatch";
}
