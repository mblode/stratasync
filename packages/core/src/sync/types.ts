import type { TransactionAction } from "../schema/types.js";
import type { SyncId } from "./sync-id.js";

/**
 * Sync action types emitted by the server.
 * Includes mutation actions plus sync-group / coverage signals.
 */
export type SyncActionType = TransactionAction | "C" | "G" | "S";

/**
 * A sync action represents a single change from the server
 */
export interface SyncAction {
  /** Monotonically increasing sync ID (string-encoded for BigInt safety) */
  id: SyncId;
  /** Name of the model that changed */
  modelName: string;
  /** ID of the model instance */
  modelId: string;
  /** Type of change */
  action: SyncActionType;
  /** Full or partial data for the model */
  data: Record<string, unknown>;
  /** Group ID for multi-tenancy filtering */
  groupId?: string;
  /** Group IDs for multi-tenancy filtering */
  groups?: string[];
  /** Client transaction ID if this was a client mutation */
  clientTxId?: string;
  /** Client ID that originated the change */
  clientId?: string;
  /** Timestamp when the change was created */
  createdAt?: Date;
  /** Class name marker (Done payloads include __class) */
  __class?: "SyncAction";
}

/**
 * A packet of delta changes from the server
 */
export interface DeltaPacket {
  /** Highest sync ID in this packet */
  lastSyncId: SyncId;
  /** Array of sync actions */
  actions: SyncAction[];
  /** Whether there are more deltas available */
  hasMore?: boolean;
}

/**
 * Bootstrap metadata for initial sync
 */
export interface BootstrapMetadata {
  /** Latest sync ID at bootstrap completion (may be omitted for partial/batch payloads) */
  lastSyncId?: SyncId;
  /** Groups returned by the server for this user */
  subscribedSyncGroups: string[];
  /** Count of returned models (by model name) */
  returnedModelsCount?: Record<string, number>;
  /** Schema hash returned by server (if provided) */
  schemaHash?: string;
  /** Server database version (if provided) */
  databaseVersion?: number;
  /** Additional metadata fields (if provided) */
  raw?: Record<string, unknown>;
}

/**
 * A row of model data during bootstrap
 */
export interface ModelRow {
  /** Model name */
  modelName: string;
  /** Row data */
  data: Record<string, unknown>;
}

/**
 * State of the sync client
 */
export type SyncClientState =
  | "disconnected"
  | "connecting"
  | "bootstrapping"
  | "syncing"
  | "error";

/**
 * Connection state for transport
 */
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

/**
 * Options for bootstrap operation
 */
export interface BootstrapOptions {
  /** Bootstrap type (full or partial) */
  type?: "full" | "partial";
  /** Models to include in bootstrap */
  onlyModels?: string[];
  /** Schema hash for validation/caching (optional) */
  schemaHash?: string;
  /** First sync ID for partial bootstrap (optional) */
  firstSyncId?: SyncId;
  /** Sync groups to bootstrap (optional) */
  syncGroups?: string[];
  /** Skip sync packets during partial bootstrap (optional) */
  noSyncPackets?: boolean;
  /** Enable CDN caching (optional) */
  useCFCaching?: boolean;
  /** Disable cache (optional) */
  noCache?: boolean;
  /** Models hash for cache validation (optional) */
  modelsHash?: string;
}

/**
 * Options for delta subscription
 */
export interface SubscribeOptions {
  /** Start after this sync ID */
  afterSyncId: SyncId;
  /** Groups to subscribe to */
  groups: string[];
}

/**
 * Delta subscription handle
 */
export interface DeltaSubscription {
  /** Async iterator of delta packets */
  [Symbol.asyncIterator](): AsyncIterator<DeltaPacket>;
  /** Unsubscribe and close connection */
  unsubscribe(): void;
}

/**
 * Batch load request for lazy-loaded models
 */
export type BatchRequest =
  | {
      /** Model name */
      modelName: string;
      /** Indexed key to filter by */
      indexedKey: string;
      /** Indexed key value */
      keyValue: string;
      /** Disallow groupId for indexed requests */
      groupId?: never;
    }
  | {
      /** Model name */
      modelName: string;
      /** Sync group ID */
      groupId: string;
      /** Disallow indexed key filters for group requests */
      indexedKey?: never;
      /** Disallow indexed key values for group requests */
      keyValue?: never;
    };

/**
 * Batch load options for partial hydration
 */
export interface BatchLoadOptions {
  /** First sync ID from full bootstrap */
  firstSyncId: SyncId;
  /** Batch requests to load */
  requests: BatchRequest[];
}
