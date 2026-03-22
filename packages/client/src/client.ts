// oxlint-disable no-use-before-define -- closure pattern requires forward references (clientRef, emitPendingCount)
import type {
  ArchiveTransactionOptions,
  BatchLoadOptions,
  ConnectionState,
  ModelRow,
  SyncClientState,
  SyncId,
  SyncStore,
  Transaction,
  UnarchiveTransactionOptions,
} from "@stratasync/core";
import {
  captureArchiveState,
  createArchivePayload,
  createUnarchivePatch,
  createUnarchivePayload,
  generateUUID,
  getOrCreateClientId,
  ModelRegistry,
  readArchivedAt,
} from "@stratasync/core";
import { YjsDocumentManager, YjsPresenceManager } from "@stratasync/yjs";

import type { HistoryEntry, HistoryOperation } from "./history-manager.js";
import { HistoryManager } from "./history-manager.js";
import { IdentityMapRegistry } from "./identity-map.js";
import { OutboxManager } from "./outbox-manager.js";
import { executeQuery } from "./query.js";
import { SyncOrchestrator } from "./sync-orchestrator.js";
import type {
  ModelChangeAction,
  ModelFactory,
  ModelFactoryFactory,
  ModelStore,
  QueryOptions,
  QueryResult,
  SyncClient,
  SyncClientEvent,
  SyncClientOptions,
} from "./types.js";
import { getModelData, getModelKey, pickOriginal } from "./utils.js";

/**
 * Default model factory: creates model instances using the constructor
 * registered in ModelRegistry, falling back to plain data objects.
 */
const defaultModelFactory: ModelFactoryFactory =
  ({ store }) =>
  (modelName: string, data: Record<string, unknown>) => {
    const ctor = ModelRegistry.getModelConstructor(modelName);
    if (!ctor) {
      return data;
    }
    const instance = new ctor() as Record<string, unknown>;
    const candidate = instance as {
      store?: SyncStore;
      _applyUpdate?: (changes: Record<string, unknown>) => void;
    };
    if ("store" in candidate) {
      candidate.store = store;
    }
    if (typeof candidate._applyUpdate === "function") {
      candidate._applyUpdate(data);
    } else {
      Object.assign(instance, data);
    }
    return instance;
  };

/**
 * Resolves a ModelFactory or ModelFactoryFactory into a ModelFactory.
 * A ModelFactoryFactory is a function that takes a store context and returns
 * a ModelFactory. We distinguish by arity: factories take 1 arg (context),
 * plain ModelFactory takes 2 (modelName, data).
 */
const resolveModelFactory = (
  factory: ModelFactory | ModelFactoryFactory | undefined,
  modelStore: ModelStore & SyncStore
): ModelFactory | undefined => {
  if (!factory) {
    return undefined;
  }
  if (typeof factory === "function" && factory.length <= 1) {
    return (factory as ModelFactoryFactory)({ store: modelStore });
  }
  return factory as ModelFactory;
};

const buildEffectiveUpdate = <T extends Record<string, unknown>>(
  existingData: T,
  changes: Partial<T>
): {
  effectiveChanges: Partial<T>;
  effectiveChangeRecord: Record<string, unknown>;
} => {
  const effectiveChanges: Partial<T> = {};
  for (const [key, value] of Object.entries(changes) as [
    keyof T,
    T[keyof T],
  ][]) {
    if (!Object.is(existingData[key as string], value)) {
      effectiveChanges[key] = value;
    }
  }

  return {
    effectiveChangeRecord: effectiveChanges as Record<string, unknown>,
    effectiveChanges,
  };
};

/**
 * Creates a sync client instance.
 *
 * Uses a closure to encapsulate mutable state (identity maps, outbox, history).
 * The `clientRef` / `getClientRef` pattern exists because the client object
 * literal needs to reference itself for history replay operations, but it
 * hasn't been assigned yet at definition time.
 */
export const createSyncClient = (options: SyncClientOptions): SyncClient => {
  const resolvedOptions: SyncClientOptions = { ...options };

  const identityMaps = new IdentityMapRegistry(
    resolvedOptions.reactivity,
    undefined,
    resolvedOptions.identityMapMaxSize
  );
  const eventListeners = new Set<(event: SyncClientEvent) => void>();
  const missingModels = new Set<string>();
  const pendingLoads = new Map<string, Promise<unknown | null>>();
  const pendingIndexLoads = new Map<
    string,
    Promise<Record<string, unknown>[]>
  >();

  const history = new HistoryManager();

  const emitEvent = (event: SyncClientEvent): void => {
    if (event.type === "modelChange") {
      const key = getModelKey(event.modelName, event.modelId);
      if (event.action === "delete") {
        missingModels.add(key);
      } else {
        missingModels.delete(key);
      }
    }

    for (const listener of eventListeners) {
      listener(event);
    }
  };

  const emitModelChange = (
    modelName: string,
    modelId: string,
    action: ModelChangeAction
  ): void => {
    emitEvent({
      action,
      modelId,
      modelName,
      type: "modelChange",
    });
  };

  const recordHistoryEntry = (
    entry: HistoryEntry | null,
    queuedTx?: Transaction
  ): void => {
    if (!entry) {
      return;
    }

    history.record(entry, queuedTx?.clientTxId);
  };

  /**
   * Rolls back a transaction by inverting its effect on the identity map.
   * This intentionally differs from `applyDeltas` (which writes to storage)
   * and `applyPendingTransactionsToIdentityMaps` (which re-applies forward).
   */
  const rollbackTransaction = (tx: Transaction): void => {
    const map = identityMaps.getMap<Record<string, unknown>>(tx.modelName);
    const existing = map.get(tx.modelId);
    const { original } = tx;

    switch (tx.action) {
      case "I": {
        if (existing) {
          map.delete(tx.modelId);
          emitModelChange(tx.modelName, tx.modelId, "delete");
        }
        break;
      }
      case "D": {
        if (original) {
          map.set(tx.modelId, original as Record<string, unknown>);
          emitModelChange(tx.modelName, tx.modelId, "insert");
        }
        break;
      }
      case "U": {
        if (!original) {
          break;
        }
        if (existing) {
          map.update(tx.modelId, original as Record<string, unknown>);
          emitModelChange(tx.modelName, tx.modelId, "update");
        } else {
          map.set(tx.modelId, original as Record<string, unknown>);
          emitModelChange(tx.modelName, tx.modelId, "insert");
        }
        break;
      }
      case "A":
      case "V": {
        if (existing) {
          map.update(
            tx.modelId,
            captureArchiveState(original as Record<string, unknown> | undefined)
          );
          emitModelChange(tx.modelName, tx.modelId, "update");
        } else if (original) {
          map.set(tx.modelId, original as Record<string, unknown>);
          emitModelChange(tx.modelName, tx.modelId, "insert");
        }
        break;
      }
      default: {
        break;
      }
    }
  };

  const applyHistoryOperation = async (
    operation: HistoryOperation
  ): Promise<string | undefined> => {
    const client = getClientRef();
    let txId: string | undefined;
    const capture = (tx: Transaction) => {
      txId = tx.clientTxId;
    };

    switch (operation.action) {
      case "I": {
        await client.create(operation.modelName, operation.payload, {
          onTransactionCreated: capture,
        });
        break;
      }
      case "U": {
        await client.update(
          operation.modelName,
          operation.modelId,
          operation.payload,
          {
            onTransactionCreated: capture,
            original: operation.original,
          }
        );
        break;
      }
      case "D": {
        await client.delete(operation.modelName, operation.modelId, {
          onTransactionCreated: capture,
          original: operation.original,
        });
        break;
      }
      case "A": {
        await client.archive(operation.modelName, operation.modelId, {
          archivedAt: readArchivedAt(operation.payload),
          onTransactionCreated: capture,
          original: operation.original,
        });
        break;
      }
      case "V": {
        await client.unarchive(operation.modelName, operation.modelId, {
          onTransactionCreated: capture,
          original: operation.original,
        });
        break;
      }
      default: {
        break;
      }
    }

    return txId;
  };

  const orchestrator = new SyncOrchestrator(
    resolvedOptions,
    identityMaps,
    emitEvent
  );

  const getStorageOpenOptions = () => ({
    name: resolvedOptions.dbName,
    schema: resolvedOptions.schema ?? orchestrator.getRegistry().snapshot(),
    userId: resolvedOptions.userId,
    userVersion: resolvedOptions.userVersion,
    version: resolvedOptions.version,
  });

  let yjsManagers: SyncClient["yjs"] | undefined;
  if (resolvedOptions.yjsTransport) {
    const clientId = getOrCreateClientId(
      `${resolvedOptions.dbName ?? "sync-db"}_client_id`
    );
    const connId = generateUUID();
    const documentManager = new YjsDocumentManager({
      clientId,
      connId,
    });
    const presenceManager = new YjsPresenceManager({
      clientId,
      connId,
    });

    // Presence must replay before document sync handshake on reconnect so
    // the server sees the connection as viewing before yjs_sync_step1.
    presenceManager.setTransport(resolvedOptions.yjsTransport);
    documentManager.setTransport(resolvedOptions.yjsTransport);

    yjsManagers = { documentManager, presenceManager };
  }

  let outboxManager: OutboxManager | null = null;
  let startPromise: Promise<void> | null = null;
  let hasStarted = false;
  let lifecycleVersion = 0;

  const buildOutboxOptions = () => ({
    batchDelay: options.batchDelay,
    batchMutations: options.batchMutations,
    clientId: orchestrator.getClientId() || "temp",
    onTransactionRejected: rollbackTransaction,
    onTransactionStateChange: async () => {
      try {
        await emitPendingCount();
      } catch (error) {
        emitEvent({
          error:
            error instanceof Error
              ? error
              : new Error("Failed to emit pending count"),
          type: "syncError",
        });
      }
    },
    storage: options.storage,
    transport: options.transport,
  });

  const createOutboxManager = (): OutboxManager => {
    const nextOutboxManager = new OutboxManager(buildOutboxOptions());
    outboxManager = nextOutboxManager;
    orchestrator.setOutboxManager(nextOutboxManager);
    return nextOutboxManager;
  };

  const replaceOutboxManager = (): OutboxManager => {
    outboxManager?.dispose();
    return createOutboxManager();
  };

  const clearOutboxManager = (): void => {
    outboxManager?.dispose();
    outboxManager = null;
  };

  const getPendingCountInternal = async (options?: {
    awaitStart?: boolean;
  }): Promise<number> => {
    if (!outboxManager) {
      return 0;
    }

    if (options?.awaitStart !== false && startPromise) {
      try {
        await startPromise;
      } catch {
        return 0;
      }

      if (!outboxManager) {
        return 0;
      }
    }

    return outboxManager.getPendingCount();
  };

  const emitPendingCount = async (options?: {
    awaitStart?: boolean;
  }): Promise<void> => {
    if (!outboxManager) {
      return;
    }
    const pendingCount = await getPendingCountInternal(options);
    emitEvent({ pendingCount, type: "outboxChange" });
  };

  const clearYjsState = (): void => {
    try {
      const documentManager = yjsManagers?.documentManager as
        | {
            destroyAll(): void;
            clearPersistedDocuments?: () => void;
          }
        | undefined;

      documentManager?.destroyAll();
      documentManager?.clearPersistedDocuments?.();
    } catch {
      // Best-effort cleanup — don't abort clearAll if Yjs teardown fails
    }
  };

  const runWithStateLock = <T>(operation: () => Promise<T>): Promise<T> =>
    orchestrator.runWithStateLock(operation);

  const createBatchLoadStream = (
    requests: BatchLoadOptions["requests"]
  ): ReturnType<SyncClientOptions["transport"]["batchLoad"]> =>
    options.transport.batchLoad({
      firstSyncId: orchestrator.getFirstSyncId(),
      requests,
    });

  const queueUpdateTransaction = async (
    modelName: string,
    id: string,
    effectiveChangeRecord: Record<string, unknown>,
    original: Record<string, unknown>,
    mutationOptions?:
      | {
          original?: Record<string, unknown>;
          onTransactionCreated?: (tx: Transaction) => void;
        }
      | undefined
  ): Promise<Transaction | undefined> => {
    if (!outboxManager) {
      return undefined;
    }

    const queuedTx = await outboxManager.update(
      modelName,
      id,
      effectiveChangeRecord,
      original
    );
    mutationOptions?.onTransactionCreated?.(queuedTx);
    return queuedTx;
  };

  const processBatchLoadRow = async (
    row: ModelRow
  ): Promise<string | undefined> =>
    await runWithStateLock(async () => {
      const rowPrimaryKey = orchestrator
        .getRegistry()
        .getPrimaryKey(row.modelName);
      const rowId = row.data[rowPrimaryKey] as string;
      if (typeof rowId !== "string") {
        return;
      }
      await options.storage.put(row.modelName, row.data);
      const rowMap = identityMaps.getMap<Record<string, unknown>>(
        row.modelName
      );
      const existed = rowMap.has(rowId);
      rowMap.merge(rowId, row.data);
      emitModelChange(row.modelName, rowId, existed ? "update" : "insert");
      return rowId;
    });

  const ensureModelInternal = async <T>(
    modelName: string,
    id: string
  ): Promise<T | null> => {
    const map = identityMaps.getMap<T & Record<string, unknown>>(modelName);
    const cached = map.get(id);
    if (cached) {
      return cached as T;
    }

    const stored = await options.storage.get<T>(modelName, id);
    if (stored) {
      map.set(id, stored as T & Record<string, unknown>);
      const key = getModelKey(modelName, id);
      missingModels.delete(key);
      return stored;
    }

    const model = orchestrator.getRegistry().getModelMetadata(modelName);
    if (!model) {
      return null;
    }

    const loadStrategy = model.loadStrategy ?? "instant";
    if (loadStrategy === "instant" || loadStrategy === "local") {
      const key = getModelKey(modelName, id);
      missingModels.add(key);
      return null;
    }

    const key = getModelKey(modelName, id);
    const pending = pendingLoads.get(key);
    if (pending) {
      return pending as Promise<T | null>;
    }

    const loadPromise = (async () => {
      let found: T | null = null;
      const primaryKey = orchestrator.getRegistry().getPrimaryKey(modelName);
      const stream = createBatchLoadStream([
        {
          indexedKey: primaryKey,
          keyValue: id,
          modelName,
        },
      ]);

      for await (const row of stream) {
        const rowId = await processBatchLoadRow(row);
        if (row.modelName === modelName && rowId === id) {
          found = row.data as T;
        }
      }

      if (found) {
        missingModels.delete(key);
      } else {
        missingModels.add(key);
      }

      return found;
    })();

    pendingLoads.set(key, loadPromise);

    try {
      return await loadPromise;
    } finally {
      pendingLoads.delete(key);
    }
  };

  const loadByIndexInternal = async <T extends Record<string, unknown>>(
    modelName: string,
    indexedKey: string,
    keyValue: string
  ): Promise<T[]> => {
    const model = orchestrator.getRegistry().getModelMetadata(modelName);
    const isPartial = model?.loadStrategy === "partial";

    if (!isPartial) {
      return options.storage.getByIndex<T>(modelName, indexedKey, keyValue);
    }

    const hasIndex = await options.storage.hasPartialIndex(
      modelName,
      indexedKey,
      keyValue
    );

    if (hasIndex) {
      return options.storage.getByIndex<T>(modelName, indexedKey, keyValue);
    }

    const loadKey = `${modelName}:${indexedKey}:${keyValue}`;
    const pending = pendingIndexLoads.get(loadKey);
    if (pending) {
      return pending as Promise<T[]>;
    }

    const loadPromise = (async () => {
      const stream = createBatchLoadStream([
        {
          indexedKey,
          keyValue,
          modelName,
        },
      ]);

      for await (const row of stream) {
        await processBatchLoadRow(row);
      }

      await options.storage.setPartialIndex(modelName, indexedKey, keyValue);
      return options.storage.getByIndex<T>(modelName, indexedKey, keyValue);
    })();

    pendingIndexLoads.set(loadKey, loadPromise);

    try {
      return await loadPromise;
    } finally {
      pendingIndexLoads.delete(loadKey);
    }
  };

  // clientRef / getClientRef: The client object literal references itself
  // (via getClientRef) for history replay operations, but it hasn't been
  // assigned yet at definition time. clientRef is set after the object is built.
  let clientRef: SyncClient | null = null;

  const getClientRef = (): SyncClient => {
    if (!clientRef) {
      throw new Error("Sync client is not initialized");
    }
    return clientRef;
  };

  const modelStore: ModelStore & SyncStore = {
    archive: (modelName, id, archiveOpts) => {
      const client = getClientRef();
      return client.archive(modelName, id, archiveOpts);
    },
    create: (modelName, data) => {
      const client = getClientRef();
      return client.create(modelName, data);
    },
    delete: (modelName, id, deleteOpts) => {
      const client = getClientRef();
      return client.delete(modelName, id, deleteOpts);
    },
    get: ensureModelInternal,
    getByIndex: (modelName, indexName, key) =>
      options.storage.getByIndex(modelName, indexName, key),
    hasPartialIndex: (modelName, indexName, key) =>
      options.storage.hasPartialIndex(modelName, indexName, key),
    loadByIndex: loadByIndexInternal,
    setPartialIndex: (modelName, indexName, key) =>
      options.storage.setPartialIndex(modelName, indexName, key),
    unarchive: (modelName, id, unarchiveOpts) => {
      const client = getClientRef();
      return client.unarchive(modelName, id, unarchiveOpts);
    },
    update: (modelName, id, changes, updateOpts) => {
      const client = getClientRef();
      return client.update(modelName, id, changes, updateOpts);
    },
  };

  const resolvedModelFactory = resolveModelFactory(
    resolvedOptions.modelFactory ?? defaultModelFactory,
    modelStore
  );
  identityMaps.setModelFactory(resolvedModelFactory);

  const client: SyncClient = {
    async archive(
      modelName: string,
      id: string,
      mutationOptions?: ArchiveTransactionOptions & {
        onTransactionCreated?: (tx: Transaction) => void;
      }
    ): Promise<void> {
      await runWithStateLock(async () => {
        const map = identityMaps.getMap(modelName);
        const existing = map.get(id);

        if (!existing) {
          throw new Error(`Model ${modelName} with id ${id} not found`);
        }

        const existingData = getModelData(existing);
        const archived = createArchivePayload(mutationOptions?.archivedAt);
        const original =
          mutationOptions?.original ?? captureArchiveState(existingData);

        if (resolvedOptions.optimistic !== false) {
          map.update(id, archived);
          emitModelChange(modelName, id, "archive");
        }

        let queuedTx: Transaction | undefined;
        if (outboxManager) {
          queuedTx = await outboxManager.archive(modelName, id, {
            archivedAt: archived.archivedAt ?? undefined,
            original,
          });
          mutationOptions?.onTransactionCreated?.(queuedTx);
        }

        recordHistoryEntry(
          history.buildEntry("A", modelName, id, archived, original),
          queuedTx
        );
      });
    },

    canRedo(): boolean {
      return history.canRedo();
    },

    canUndo(): boolean {
      return history.canUndo();
    },

    async clearAll(): Promise<void> {
      const pendingStart = startPromise;
      lifecycleVersion += 1;
      startPromise = null;
      hasStarted = false;
      await outboxManager?.clear();
      clearOutboxManager();
      clearYjsState();
      await orchestrator.reset();
      identityMaps.clearAll();
      await options.storage.close();
      await options.storage.open(getStorageOpenOptions());
      try {
        await options.storage.clear();
      } finally {
        await options.storage.close();
      }
      pendingLoads.clear();
      pendingIndexLoads.clear();
      missingModels.clear();
      history.clear();
      await pendingStart?.catch(() => {
        /* noop */
      });
      emitEvent({ pendingCount: 0, type: "outboxChange" });
    },

    get clientId(): string {
      return orchestrator.getClientId();
    },

    get connectionState(): ConnectionState {
      return orchestrator.connectionState;
    },

    async create<T extends Record<string, unknown>>(
      modelName: string,
      data: T,
      mutationOptions?: { onTransactionCreated?: (tx: Transaction) => void }
    ): Promise<T> {
      return await runWithStateLock(async () => {
        const primaryKey = orchestrator.getRegistry().getPrimaryKey(modelName);

        // Generate ID if not provided
        const id = (data[primaryKey] as string) || generateUUID();
        const fullData = { ...data, [primaryKey]: id };

        if (resolvedOptions.optimistic !== false) {
          const map = identityMaps.getMap<T>(modelName);
          map.set(id, fullData);
          missingModels.delete(getModelKey(modelName, id));
          emitModelChange(modelName, id, "insert");
        }

        let queuedTx: Transaction | undefined;
        if (outboxManager) {
          queuedTx = await outboxManager.insert(modelName, id, fullData);
          mutationOptions?.onTransactionCreated?.(queuedTx);
        }

        recordHistoryEntry(
          history.buildEntry("I", modelName, id, fullData),
          queuedTx
        );

        return fullData;
      });
    },

    async delete(
      modelName: string,
      id: string,
      mutationOptions?: {
        original?: Record<string, unknown>;
        onTransactionCreated?: (tx: Transaction) => void;
      }
    ): Promise<void> {
      await runWithStateLock(async () => {
        const map = identityMaps.getMap(modelName);
        const existing = map.get(id);

        if (!existing) {
          throw new Error(`Model ${modelName} with id ${id} not found`);
        }

        if (resolvedOptions.optimistic !== false) {
          map.delete(id);
          emitModelChange(modelName, id, "delete");
        }

        const original = mutationOptions?.original ?? getModelData(existing);
        let queuedTx: Transaction | undefined;
        if (outboxManager) {
          queuedTx = await outboxManager.delete(modelName, id, original);
          mutationOptions?.onTransactionCreated?.(queuedTx);
        }

        recordHistoryEntry(
          history.buildEntry("D", modelName, id, {}, original),
          queuedTx
        );
      });
    },

    ensureModel<T>(modelName: string, id: string): Promise<T | null> {
      return ensureModelInternal(modelName, id);
    },

    async get<T>(modelName: string, id: string): Promise<T | null> {
      // Try identity map first
      const map = identityMaps.getMap<T & Record<string, unknown>>(modelName);
      const cached = map.get(id);
      if (cached) {
        return cached as T;
      }

      // Fall back to storage
      const stored = await options.storage.get<T>(modelName, id);
      if (stored) {
        // Cache in identity map
        map.set(id, stored as T & Record<string, unknown>);
      }
      return stored;
    },

    getAll<T>(modelName: string, queryOptions?: QueryOptions<T>): Promise<T[]> {
      const map = identityMaps.getMap<T & Record<string, unknown>>(modelName);
      const result = executeQuery(map, queryOptions);
      return Promise.resolve(result.data as T[]);
    },

    getCached<T>(modelName: string, id: string): T | null {
      const map = identityMaps.getMap<T & Record<string, unknown>>(modelName);
      const cached = map.get(id);
      return cached ? (cached as T) : null;
    },

    getIdentityMap<T>(modelName: string): Map<string, T> {
      return identityMaps
        .getMap<T & Record<string, unknown>>(modelName)
        .getRawMap() as Map<string, T>;
    },

    getPendingCount(): Promise<number> {
      return getPendingCountInternal();
    },

    isModelMissing(modelName: string, id: string): boolean {
      return missingModels.has(getModelKey(modelName, id));
    },

    get lastError(): Error | null {
      return orchestrator.getLastError();
    },

    get lastSyncId(): SyncId {
      return orchestrator.getLastSyncId();
    },

    onConnectionStateChange(
      // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
      callback: (state: ConnectionState) => void
    ): () => void {
      return orchestrator.onConnectionStateChange(callback);
    },

    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    onEvent(callback: (event: SyncClientEvent) => void): () => void {
      eventListeners.add(callback);
      return () => {
        eventListeners.delete(callback);
      };
    },

    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    onStateChange(callback: (state: SyncClientState) => void): () => void {
      return orchestrator.onStateChange(callback);
    },

    query<T>(
      modelName: string,
      queryOptions?: QueryOptions<T>
    ): Promise<QueryResult<T>> {
      const map = identityMaps.getMap<T & Record<string, unknown>>(modelName);
      return Promise.resolve(executeQuery(map, queryOptions) as QueryResult<T>);
    },

    async redo(): Promise<void> {
      await history.redo(applyHistoryOperation);
    },

    async runAsUndoGroup<T>(operation: () => Promise<T> | T): Promise<T> {
      return await history.runAsGroup(operation);
    },

    start(): Promise<void> {
      if (startPromise) {
        return startPromise;
      }
      if (hasStarted) {
        return Promise.resolve();
      }

      const startVersion = lifecycleVersion;
      let currentStartPromise: Promise<void> = Promise.resolve();
      currentStartPromise = (async () => {
        replaceOutboxManager();
        orchestrator.setConflictHandler(rollbackTransaction);

        try {
          await orchestrator.start();

          if (startVersion !== lifecycleVersion) {
            return;
          }

          // Recreate with correct client ID after orchestrator resolves it.
          replaceOutboxManager();
          hasStarted = true;

          await emitPendingCount({ awaitStart: false });
        } catch (error) {
          if (startVersion === lifecycleVersion) {
            clearOutboxManager();
            hasStarted = false;
          }
          throw error;
        } finally {
          if (startPromise === currentStartPromise) {
            startPromise = null;
          }
        }
      })();

      startPromise = currentStartPromise;
      return currentStartPromise;
    },

    get state(): SyncClientState {
      return orchestrator.state;
    },

    async stop(): Promise<void> {
      const pendingStart = startPromise;
      lifecycleVersion += 1;
      startPromise = null;
      hasStarted = false;
      clearOutboxManager();
      await orchestrator.stop();
      await pendingStart?.catch(() => {
        /* noop */
      });
    },

    async syncNow(): Promise<void> {
      await orchestrator.syncNow();
    },

    async unarchive(
      modelName: string,
      id: string,
      mutationOptions?: UnarchiveTransactionOptions & {
        onTransactionCreated?: (tx: Transaction) => void;
      }
    ): Promise<void> {
      await runWithStateLock(async () => {
        const map = identityMaps.getMap(modelName);
        const existing = map.get(id);

        if (!existing) {
          throw new Error(`Model ${modelName} with id ${id} not found`);
        }

        const existingData = getModelData(existing);
        const original =
          mutationOptions?.original ?? captureArchiveState(existingData);
        const unarchivePatch = createUnarchivePatch();

        if (resolvedOptions.optimistic !== false) {
          map.update(id, unarchivePatch);
          emitModelChange(modelName, id, "unarchive");
        }

        let queuedTx: Transaction | undefined;
        if (outboxManager) {
          queuedTx = await outboxManager.unarchive(modelName, id, { original });
          mutationOptions?.onTransactionCreated?.(queuedTx);
        }

        recordHistoryEntry(
          history.buildEntry(
            "V",
            modelName,
            id,
            createUnarchivePayload(),
            original
          ),
          queuedTx
        );
      });
    },

    async undo(): Promise<void> {
      await history.undo(applyHistoryOperation);
    },

    async update<T extends Record<string, unknown>>(
      modelName: string,
      id: string,
      changes: Partial<T>,
      mutationOptions?: {
        original?: Record<string, unknown>;
        onTransactionCreated?: (tx: Transaction) => void;
      }
    ): Promise<T> {
      // Apply the optimistic update synchronously (outside the state lock)
      // so MobX observers see it immediately and the identity map is updated
      // before any concurrent delta processing can run. The outbox queue and
      // history recording still use the lock to serialize with deltas.
      const map = identityMaps.getMap<T>(modelName);
      const existing = map.get(id);

      if (!existing) {
        throw new Error(`Model ${modelName} with id ${id} not found`);
      }

      const existingData = getModelData(existing) as T;
      const { effectiveChanges, effectiveChangeRecord } = buildEffectiveUpdate(
        existingData,
        changes
      );

      if (Object.keys(effectiveChangeRecord).length === 0) {
        return existingData as T;
      }

      const originalSource = mutationOptions?.original ?? existingData;
      const original = pickOriginal(originalSource, effectiveChangeRecord);
      const updated = { ...existingData, ...effectiveChanges } as T;

      if (resolvedOptions.optimistic !== false) {
        map.update(id, effectiveChanges);
        missingModels.delete(getModelKey(modelName, id));
        emitModelChange(modelName, id, "update");
      }

      await runWithStateLock(async () => {
        const queuedTx = await queueUpdateTransaction(
          modelName,
          id,
          effectiveChangeRecord,
          original,
          mutationOptions
        );

        recordHistoryEntry(
          history.buildEntry(
            "U",
            modelName,
            id,
            effectiveChangeRecord,
            original
          ),
          queuedTx
        );
      });

      return updated;
    },

    yjs: yjsManagers,
  };

  clientRef = client;
  return client;
};
