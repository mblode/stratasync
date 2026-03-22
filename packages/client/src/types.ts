import type {
  ArchiveTransactionOptions,
  BatchLoadOptions,
  BootstrapMetadata,
  BootstrapOptions,
  ConnectionState,
  DeltaPacket,
  DeltaSubscription,
  ModelRegistrySnapshot,
  ModelRow,
  MutateResult,
  ReactivityAdapter,
  SchemaDefinition,
  SubscribeOptions,
  SyncAction,
  SyncClientState,
  SyncId,
  Transaction,
  TransactionBatch,
  UnarchiveTransactionOptions,
} from "@stratasync/core";
import type {
  YjsDocumentManager,
  YjsPresenceManager,
  YjsTransport,
} from "@stratasync/yjs";

/**
 * Storage adapter options
 */
export interface StorageOptions {
  /** Database name */
  name?: string;
  /** Client version used to derive the workspace database name */
  version?: number;
  /** Logged-in user ID (used to derive the workspace database name) */
  userId?: string;
  /** Per-user version used to derive the workspace database name */
  userVersion?: number;
  /** Schema definition or registry snapshot */
  schema?: SchemaDefinition | ModelRegistrySnapshot;
}

/**
 * Batch operation types for atomic writes
 */
type BatchOperationType = "put" | "delete";

/**
 * A single batch operation
 */
export interface BatchOperation {
  /** Operation type */
  type: BatchOperationType;
  /** Model/store name */
  modelName: string;
  /** Row ID (for delete) or row data (for put) */
  id?: string;
  /** Row data (for put) */
  data?: Record<string, unknown>;
}

/**
 * Options for clearing persisted client state.
 */
export interface ClearStorageOptions {
  /**
   * Preserve outbox transactions while clearing model/meta state.
   * Useful during full bootstrap to avoid dropping unsynced mutations.
   */
  preserveOutbox?: boolean;
}

/**
 * Storage adapter interface
 */
export interface StorageAdapter {
  open(options: StorageOptions): Promise<void>;
  close(): Promise<void>;
  get<T>(modelName: string, id: string): Promise<T | null>;
  getAll<T>(modelName: string): Promise<T[]>;
  put<T extends Record<string, unknown>>(
    modelName: string,
    row: T
  ): Promise<void>;
  delete(modelName: string, id: string): Promise<void>;
  getByIndex<T>(
    modelName: string,
    indexName: string,
    key: string
  ): Promise<T[]>;
  writeBatch(ops: BatchOperation[]): Promise<void>;
  getMeta(): Promise<StorageMeta>;
  setMeta(meta: Partial<StorageMeta>): Promise<void>;
  getModelPersistence(modelName: string): Promise<ModelPersistenceMeta>;
  setModelPersistence(modelName: string, persisted: boolean): Promise<void>;
  getOutbox(): Promise<Transaction[]>;
  addToOutbox(tx: Transaction): Promise<void>;
  removeFromOutbox(clientTxId: string): Promise<void>;
  updateOutboxTransaction(
    clientTxId: string,
    updates: Partial<Transaction>
  ): Promise<void>;
  hasPartialIndex(
    modelName: string,
    indexedKey: string,
    keyValue: string
  ): Promise<boolean>;
  setPartialIndex(
    modelName: string,
    indexedKey: string,
    keyValue: string
  ): Promise<void>;
  addSyncActions(actions: SyncAction[]): Promise<void>;
  getSyncActions(afterSyncId?: SyncId, limit?: number): Promise<SyncAction[]>;
  clearSyncActions(): Promise<void>;
  clear(options?: ClearStorageOptions): Promise<void>;
  count(modelName: string): Promise<number>;
}

/**
 * Store interface for model instances (lazy relations)
 */
export interface ModelStore {
  get<T extends Record<string, unknown>>(
    modelName: string,
    id: string
  ): Promise<T | null>;
  getByIndex?<T extends Record<string, unknown>>(
    modelName: string,
    indexName: string,
    key: string
  ): Promise<T[]>;
  loadByIndex?<T extends Record<string, unknown>>(
    modelName: string,
    indexName: string,
    key: string
  ): Promise<T[]>;
  hasPartialIndex?(
    modelName: string,
    indexName: string,
    key: string
  ): Promise<boolean>;
  setPartialIndex?(
    modelName: string,
    indexName: string,
    key: string
  ): Promise<void>;
}

/**
 * Model factory for creating model instances from raw data
 */
export type ModelFactory = (
  modelName: string,
  data: Record<string, unknown>
) => Record<string, unknown>;

/**
 * Context passed to model factory builders
 */
export interface ModelFactoryContext {
  store: ModelStore;
}

/**
 * Model factory builder (receives store context)
 */
export type ModelFactoryFactory = (
  context: ModelFactoryContext
) => ModelFactory;

/**
 * Storage metadata
 */
export interface StorageMeta {
  schemaHash?: string;
  lastSyncId: SyncId;
  firstSyncId?: SyncId;
  subscribedSyncGroups?: string[];
  clientId?: string;
  bootstrapComplete?: boolean;
  lastSyncAt?: number;
  databaseVersion?: number;
  updatedAt?: number;
}

export interface ModelPersistenceMeta {
  modelName: string;
  persisted: boolean;
  updatedAt?: number;
}

/**
 * Transport adapter interface (from sync-transport-graphql or similar)
 */
export interface TransportAdapter {
  bootstrap(
    options: BootstrapOptions
  ): AsyncGenerator<ModelRow, BootstrapMetadata, unknown>;
  batchLoad(options: BatchLoadOptions): AsyncIterable<ModelRow>;
  mutate(batch: TransactionBatch): Promise<MutateResult>;
  subscribe(options: SubscribeOptions): DeltaSubscription;
  fetchDeltas(
    after: SyncId,
    limit?: number,
    groups?: string[]
  ): Promise<DeltaPacket>;
  getConnectionState(): ConnectionState;
  onConnectionStateChange(
    callback: (state: ConnectionState) => void
  ): () => void;
  close(): Promise<void>;
}

/**
 * Sync client options
 */
export interface SyncClientOptions {
  /** Storage adapter (e.g., IndexedDB) */
  storage: StorageAdapter;
  /** Transport adapter (e.g., GraphQL) */
  transport: TransportAdapter;
  /** Reactivity adapter (e.g., MobX) */
  reactivity: ReactivityAdapter;
  /** Schema definition or registry snapshot */
  schema?: SchemaDefinition | ModelRegistrySnapshot;
  /** Optional model factory (or factory builder) */
  modelFactory?: ModelFactory | ModelFactoryFactory;
  /** Database name for storage */
  dbName?: string;
  /** Logged-in user ID for storage naming */
  userId?: string;
  /** Client version for storage naming */
  version?: number;
  /** Per-user version for storage naming */
  userVersion?: number;
  /** Groups to sync (for multi-tenancy) */
  groups?: string[];
  /** Maximum number of cached models to keep per identity map */
  identityMapMaxSize?: number;
  /** Enable optimistic updates */
  optimistic?: boolean;
  /** Batch mutations before sending */
  batchMutations?: boolean;
  /** Mutation batch delay in ms */
  batchDelay?: number;
  /** Bootstrap mode selection */
  bootstrapMode?: "auto" | "full" | "local";
  /** Optional Yjs transport for live editing */
  yjsTransport?: YjsTransport;
  /** Default conflict resolution strategy for transaction rebasing (default: "server-wins") */
  rebaseStrategy?: "server-wins" | "client-wins" | "merge";
  /** Enable field-level conflict detection for rebasing (default: true) */
  fieldLevelConflicts?: boolean;
}

/**
 * Query options for fetching models
 */
export interface QueryOptions<T> {
  /** Filter function */
  where?: (item: T) => boolean;
  /** Sort function */
  orderBy?: (a: T, b: T) => number;
  /** Maximum number of results */
  limit?: number;
  /** Number of results to skip */
  offset?: number;
  /** Include soft-deleted items */
  includeArchived?: boolean;
}

/**
 * Query result with metadata
 */
export interface QueryResult<T> {
  /** Query results */
  data: T[];
  /** Whether more results are available */
  hasMore: boolean;
  /** Total count (if available) */
  totalCount?: number;
}

export type ModelChangeAction =
  | "insert"
  | "update"
  | "delete"
  | "archive"
  | "unarchive";

export type SyncClientEvent =
  | { type: "syncStart" }
  | { type: "syncComplete"; lastSyncId: SyncId }
  | { type: "syncError"; error: Error }
  | { type: "stateChange"; state: SyncClientState }
  | { type: "connectionChange"; state: ConnectionState }
  | { type: "outboxChange"; pendingCount: number }
  | {
      type: "modelChange";
      modelName: string;
      modelId: string;
      action: ModelChangeAction;
    }
  | {
      type: "rebaseConflict";
      modelName: string;
      modelId: string;
      conflictType: string;
      resolution: string;
    };

/**
 * Sync client interface
 */
export interface SyncClient {
  /** Current client state */
  state: SyncClientState;

  /** Current connection state */
  connectionState: ConnectionState;

  /** Last sync ID received from server */
  lastSyncId: SyncId;

  /** Last error (if any) */
  lastError: Error | null;

  /** Client ID */
  clientId: string;

  /** Yjs managers for live editing (if configured) */
  yjs?: {
    documentManager: YjsDocumentManager;
    presenceManager: YjsPresenceManager;
  };

  /** Start the sync client */
  start(): Promise<void>;

  /** Stop the sync client */
  stop(): Promise<void>;

  /** Get a model by ID */
  get<T>(modelName: string, id: string): Promise<T | null>;

  /** Get a cached model by ID (no network) */
  getCached<T>(modelName: string, id: string): T | null;

  /** Ensure a model is available locally, loading if needed */
  ensureModel<T>(modelName: string, id: string): Promise<T | null>;

  /** Get all models of a type */
  getAll<T>(modelName: string, options?: QueryOptions<T>): Promise<T[]>;

  /** Query models */
  query<T>(
    modelName: string,
    options?: QueryOptions<T>
  ): Promise<QueryResult<T>>;

  /** Create a new model */
  create<T extends Record<string, unknown>>(
    modelName: string,
    data: T,
    options?: { onTransactionCreated?: (tx: Transaction) => void }
  ): Promise<T>;

  /** Update a model */
  update<T extends Record<string, unknown>>(
    modelName: string,
    id: string,
    changes: Partial<T>,
    options?: {
      original?: Record<string, unknown>;
      onTransactionCreated?: (tx: Transaction) => void;
    }
  ): Promise<T>;

  /** Delete a model */
  delete(
    modelName: string,
    id: string,
    options?: {
      original?: Record<string, unknown>;
      onTransactionCreated?: (tx: Transaction) => void;
    }
  ): Promise<void>;

  /** Archive a model (soft delete) */
  archive(
    modelName: string,
    id: string,
    options?: ArchiveTransactionOptions & {
      onTransactionCreated?: (tx: Transaction) => void;
    }
  ): Promise<void>;

  /** Unarchive a model */
  unarchive(
    modelName: string,
    id: string,
    options?: UnarchiveTransactionOptions & {
      onTransactionCreated?: (tx: Transaction) => void;
    }
  ): Promise<void>;

  /** Whether undo is available */
  canUndo(): boolean;

  /** Whether redo is available */
  canRedo(): boolean;

  /** Undo the last operation */
  undo(): Promise<void>;

  /** Redo the last undone operation */
  redo(): Promise<void>;

  /** Capture all mutations in the callback as a single undoable UI operation */
  runAsUndoGroup<T>(operation: () => Promise<T> | T): Promise<T>;

  /** Subscribe to events */
  onEvent(callback: (event: SyncClientEvent) => void): () => void;

  /** Subscribe to state changes */
  onStateChange(callback: (state: SyncClientState) => void): () => void;

  /** Subscribe to connection state changes */
  onConnectionStateChange(
    callback: (state: ConnectionState) => void
  ): () => void;

  /** Get pending transaction count */
  getPendingCount(): Promise<number>;

  /** Force a sync now */
  syncNow(): Promise<void>;

  /** Clear all local data */
  clearAll(): Promise<void>;

  /** Get the identity map for a model type */
  getIdentityMap<T>(modelName: string): Map<string, T>;

  /** Whether a model was previously missing in storage/network */
  isModelMissing(modelName: string, id: string): boolean;
}
