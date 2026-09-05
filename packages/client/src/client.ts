// oxlint-disable no-use-before-define -- closure pattern requires forward references (mutations, materializeModelResult, emitPendingCount)
import type {
  ArchiveTransactionOptions,
  ConnectionState,
  SyncClientState,
  SyncId,
  SyncStore,
  Transaction,
  UnarchiveTransactionOptions,
} from "@stratasync/core";
import {
  captureArchiveState,
  deserializeModelRecord,
  generateUUID,
  getOrCreateClientId,
  readArchivedAt,
  serializeModelRecord,
} from "@stratasync/core";

import type { HistoryEntry, HistoryOperation } from "./history-manager.js";
import { HistoryManager } from "./history-manager.js";
import { IdentityMapRegistry } from "./identity-map.js";
import { LazyLoader } from "./loader.js";
import {
  createDefaultModelFactory,
  createMaterializer,
  resolveModelFactory,
} from "./materializer.js";
import { MutationCoordinator } from "./mutations.js";
import { OutboxManager } from "./outbox-manager.js";
import { executeQuery } from "./query.js";
import { SyncOrchestrator } from "./sync-orchestrator.js";
import {
  applyPendingTransactionsToIdentityMaps,
  excludePrivacyWithheldTransactions,
} from "./sync/pending-hydration.js";
import type {
  ModelChangeAction,
  ModelStore,
  QueryOptions,
  QueryResult,
  SyncClient,
  SyncClientEvent,
  SyncClientOptions,
} from "./types.js";
import { getModelData, getModelKey } from "./utils.js";

const MUTATION_START_REQUIRED_ERROR =
  "Sync client must be started before mutations";

/**
 * Creates a sync client instance.
 *
 * Uses a closure to encapsulate mutable state (identity maps, outbox, history).
 * Mutations route through the `MutationCoordinator`; the model store and
 * history replay delegate to it lazily, so no self-reference is needed.
 */
export const createSyncClient = (options: SyncClientOptions): SyncClient => {
  const resolvedOptions: SyncClientOptions = { ...options };

  const identityMaps = new IdentityMapRegistry(
    resolvedOptions.reactivity,
    undefined,
    resolvedOptions.identityMapMaxSize,
    // Emit an "update" (not "delete") when the LRU cache evicts an entry: hooks
    // re-render and Suspense re-hydrates the model, and because it is not a
    // delete, missingModels is cleared rather than poisoned. The arrow resolves
    // emitModelChange lazily at eviction time (it is defined below).
    (m, id) => emitModelChange(m, id, "update")
  );
  const eventListeners = new Set<(event: SyncClientEvent) => void>();
  const missingModels = new Set<string>();

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
    if (!entry || queuedTx?.state === "failed") {
      return;
    }

    history.record(entry, queuedTx?.clientTxId);
  };

  const handleRejectedTransaction = (tx: Transaction): void => {
    rollbackTransaction(tx);
    history.removeByTxId(tx.clientTxId);
    emitEvent({
      action: tx.action,
      error: tx.lastError ?? "Mutation rejected",
      modelId: tx.modelId,
      modelName: tx.modelName,
      type: "mutationRejected",
    });
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

  const rollbackOptimisticMutation = (
    action: Transaction["action"],
    modelName: string,
    modelId: string,
    original?: Record<string, unknown>
  ): void => {
    rollbackTransaction({
      action,
      clientId: orchestrator.getClientId() || "rollback",
      clientTxId: `rollback:${generateUUID()}`,
      createdAt: Date.now(),
      modelId,
      modelName,
      original,
      payload: {},
      retryCount: 0,
      state: "failed",
    });
  };

  const applyHistoryOperation = async (
    operation: HistoryOperation
  ): Promise<string | undefined> => {
    let txId: string | undefined;
    const capture = (tx: Transaction) => {
      txId = tx.clientTxId;
    };

    switch (operation.action) {
      case "I": {
        await mutations.create(operation.modelName, operation.payload, {
          onTransactionCreated: capture,
        });
        break;
      }
      case "U": {
        await mutations.update(
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
        await mutations.delete(operation.modelName, operation.modelId, {
          onTransactionCreated: capture,
          original: operation.original,
        });
        break;
      }
      case "A": {
        await mutations.archive(operation.modelName, operation.modelId, {
          archivedAt: readArchivedAt(operation.payload),
          onTransactionCreated: capture,
          original: operation.original,
        });
        break;
      }
      case "V": {
        await mutations.unarchive(operation.modelName, operation.modelId, {
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

  // Only demand-loadable models may be evicted. `instant` models are declared
  // to sync in full and `ensureModel` refuses to refetch them, so evicting one
  // would silently drop it from every query until the next bootstrap; `local`
  // models never sync, so the in-memory copy is the only one.
  identityMaps.setEvictionPolicy((modelName) => {
    const strategy =
      orchestrator.getRegistry().getModelMetadata(modelName)?.loadStrategy ??
      "instant";
    return strategy !== "instant" && strategy !== "local";
  });

  const getStorageOpenOptions = () => ({
    name: resolvedOptions.dbName,
    schema: resolvedOptions.schema ?? orchestrator.getRegistry().snapshot(),
    userId: resolvedOptions.userId,
    userVersion: resolvedOptions.userVersion,
    version: resolvedOptions.version,
  });

  let yjsManagers: SyncClient["yjs"] | undefined;
  if (resolvedOptions.yjs) {
    yjsManagers =
      typeof resolvedOptions.yjs === "function"
        ? resolvedOptions.yjs({
            clientId: getOrCreateClientId(
              `${resolvedOptions.dbName ?? "sync-db"}_client_id`
            ),
            connId: generateUUID(),
          })
        : resolvedOptions.yjs;
  }

  let outboxManager: OutboxManager | null = null;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let hasStarted = false;
  let lifecycleVersion = 0;

  const buildOutboxOptions = () => {
    const clientId = orchestrator.getClientId();
    if (!clientId) {
      throw new Error("Sync client ID is not available");
    }

    return {
      batchDelay: options.batchDelay,
      batchMutations: options.batchMutations,
      clientId,
      onTransactionRejected: handleRejectedTransaction,
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
    };
  };

  const createOutboxManager = (): OutboxManager => {
    const nextOutboxManager = new OutboxManager(buildOutboxOptions());
    outboxManager = nextOutboxManager;
    orchestrator.setOutboxManager(nextOutboxManager);
    return nextOutboxManager;
  };

  const clearOutboxManager = (): void => {
    outboxManager?.dispose();
    outboxManager = null;
    orchestrator.setOutboxManager(null);
  };

  const waitForInflightSends = async (): Promise<void> => {
    if (!outboxManager) {
      return;
    }

    await outboxManager.waitForInflightSends();
  };

  const getPendingCountInternal = async (pendingOpts?: {
    awaitStart?: boolean;
  }): Promise<number> => {
    if (pendingOpts?.awaitStart !== false && startPromise) {
      try {
        await startPromise;
      } catch {
        return 0;
      }
    }

    if (!outboxManager) {
      return 0;
    }

    return outboxManager.getPendingCount();
  };

  const emitPendingCount = async (pendingOpts?: {
    awaitStart?: boolean;
  }): Promise<void> => {
    if (!outboxManager) {
      return;
    }
    const pendingCount = await getPendingCountInternal(pendingOpts);
    emitEvent({ pendingCount, type: "outboxChange" });
  };

  const getStartedOutboxManager = (): OutboxManager => {
    if (!(hasStarted && outboxManager)) {
      throw new Error(MUTATION_START_REQUIRED_ERROR);
    }

    return outboxManager;
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
      // Best-effort cleanup. Don't abort clearAll if Yjs teardown fails.
    }
  };

  const runWithStateLock = <T>(operation: () => Promise<T>): Promise<T> =>
    orchestrator.runWithStateLock(operation);

  /**
   * Invalidates the current lifecycle so an in-flight `start()` abandons its
   * run, then executes `teardown` after any teardown already in progress.
   * `stop()` and `clearAll()` share this so they never interleave with each
   * other or with the start they are cancelling.
   */
  const runLifecycleTeardown = async (
    teardown: (pendingStart: Promise<void> | null) => Promise<void>
  ): Promise<void> => {
    const previousTeardown = stopPromise;
    const pendingStart = startPromise;
    lifecycleVersion += 1;
    startPromise = null;
    hasStarted = false;

    const teardownPromise = (async () => {
      await previousTeardown?.catch(() => {
        /* the earlier teardown reported its own failure */
      });
      await teardown(pendingStart);
    })();

    stopPromise = teardownPromise;
    try {
      await teardownPromise;
    } finally {
      if (stopPromise === teardownPromise) {
        stopPromise = null;
      }
    }
  };

  /**
   * Cancels the orchestrator run and waits for an in-flight `start()` to
   * observe the cancellation before the caller closes or clears storage, so a
   * bootstrap that was mid-commit cannot write into a store being torn down.
   */
  const cancelActiveRun = async (
    pendingStart: Promise<void> | null
  ): Promise<void> => {
    await orchestrator.reset();
    await pendingStart?.catch(() => {
      /* a cancelled start has nothing left to report */
    });
  };

  const runWithMutationOutbox = async <T>(
    operation: (activeOutboxManager: OutboxManager) => Promise<T>
  ): Promise<T> => {
    if (startPromise) {
      await startPromise;
    }

    return runWithStateLock(() => operation(getStartedOutboxManager()));
  };

  const rehydrateOutboxWithSyncCursor = async (
    activeOutboxManager: OutboxManager
  ): Promise<void> => {
    await runWithStateLock(async () => {
      await activeOutboxManager.completeUpToSyncId(
        orchestrator.getLastSyncId()
      );
      const pending = await activeOutboxManager.getActiveTransactions();
      if (pending.length > 0) {
        const meta = await options.storage.getMeta();
        identityMaps.batch(() => {
          applyPendingTransactionsToIdentityMaps(
            identityMaps,
            excludePrivacyWithheldTransactions(
              pending,
              meta.privacyWithheldClientTxIds,
              identityMaps
            )
          );
        });
      }
    });
  };

  const serializeMutationRecord = (
    modelName: string,
    data: Record<string, unknown>
  ): Record<string, unknown> =>
    serializeModelRecord(
      orchestrator.getRegistry().getModelProperties(modelName),
      data
    );

  const deserializeMutationRecord = (
    modelName: string,
    data: Record<string, unknown>
  ): Record<string, unknown> =>
    deserializeModelRecord(
      orchestrator.getRegistry().getModelProperties(modelName),
      data
    );

  const loader = new LazyLoader({
    emitModelChange,
    identityMaps,
    materialize: (modelName, id, data, materializeOptions) =>
      materializeModelResult(modelName, id, data, materializeOptions),
    missingModels,
    orchestrator,
    runWithStateLock,
    storage: options.storage,
    transport: options.transport,
  });

  // A `"C"` action grants coverage of a partial index key without carrying the
  // rows, so fetch them. `loadByIndex` records the coverage once the rows land.
  orchestrator.setCoverageLoader(async (modelName, indexedKey, keyValue) => {
    await loader.loadByIndex(modelName, indexedKey, keyValue);
  });

  const ensureModelInternal = <T>(
    modelName: string,
    id: string
  ): Promise<T | null> => loader.ensureModel<T>(modelName, id);

  const loadByIndexInternal = <T extends Record<string, unknown>>(
    modelName: string,
    indexedKey: string,
    keyValue: string
  ): Promise<T[]> => loader.loadByIndex<T>(modelName, indexedKey, keyValue);

  // The model store routes mutations through the MutationCoordinator (declared
  // below). The delegating arrows resolve `mutations` lazily at call time, so no
  // self-reference (clientRef) hack is needed.
  const modelStore: ModelStore & SyncStore = {
    archive: (modelName, id, archiveOpts) =>
      mutations.archive(modelName, id, archiveOpts),
    create: (modelName, data) => mutations.create(modelName, data),
    delete: (modelName, id, deleteOpts) =>
      mutations.delete(modelName, id, deleteOpts),
    get: <T extends Record<string, unknown>>(
      modelName: string,
      id: string
    ): Promise<T | null> => ensureModelInternal<T>(modelName, id),
    getAll: <T extends Record<string, unknown>>(modelName: string): T[] =>
      identityMaps.getMap<T>(modelName).values(),
    getByIndex: (modelName, indexName, key) =>
      options.storage.getByIndex(modelName, indexName, key),
    getCached: <T extends Record<string, unknown>>(
      modelName: string,
      id: string
    ): T | null => {
      const map = identityMaps.getMap<T>(modelName);
      return map.get(id) ?? null;
    },
    hasPartialIndex: (modelName, indexName, key) =>
      options.storage.hasPartialIndex(modelName, indexName, key),
    loadByIndex: loadByIndexInternal,
    setPartialIndex: (modelName, indexName, key) =>
      options.storage.setPartialIndex(modelName, indexName, key),
    unarchive: (modelName, id, unarchiveOpts) =>
      mutations.unarchive(modelName, id, unarchiveOpts),
    update: async (modelName, id, changes, updateOpts) => {
      const updated = await mutations.update(
        modelName,
        id,
        deserializeMutationRecord(modelName, changes),
        {
          alreadyApplied: true,
          original: updateOpts?.original
            ? deserializeMutationRecord(modelName, updateOpts.original)
            : undefined,
        }
      );
      return serializeMutationRecord(modelName, getModelData(updated));
    },
  };

  const resolvedModelFactory =
    resolveModelFactory(resolvedOptions.modelFactory, modelStore) ??
    createDefaultModelFactory(orchestrator.getRegistry(), modelStore);

  const materializeModelResult = createMaterializer(
    identityMaps,
    resolvedModelFactory
  );
  identityMaps.setModelFactory(resolvedModelFactory);

  const mutations = new MutationCoordinator({
    buildHistoryEntry: (action, modelName, modelId, payload, original) =>
      history.buildEntry(action, modelName, modelId, payload, original),
    emitModelChange,
    getRegistry: () => orchestrator.getRegistry(),
    identityMaps,
    isOptimistic: () => resolvedOptions.optimistic !== false,
    markPresent: (modelName, id) => {
      missingModels.delete(getModelKey(modelName, id));
    },
    materialize: (modelName, id, data, materializeOptions) =>
      materializeModelResult(modelName, id, data, materializeOptions),
    recordHistoryEntry,
    rollbackOptimisticMutation,
    runWithMutationOutbox,
    serializeMutationRecord,
  });

  const client: SyncClient = {
    archive(
      modelName: string,
      id: string,
      mutationOptions?: ArchiveTransactionOptions & {
        onTransactionCreated?: (tx: Transaction) => void;
      }
    ): Promise<void> {
      return mutations.archive(modelName, id, mutationOptions);
    },

    canRedo(): boolean {
      return history.canRedo();
    },

    canUndo(): boolean {
      return history.canUndo();
    },

    get catchingUp(): boolean {
      return orchestrator.catchingUp;
    },

    async clearAll(): Promise<void> {
      const doClear = async (pendingStart: Promise<void> | null) => {
        await waitForInflightSends();
        await outboxManager?.clear();
        clearOutboxManager();
        clearYjsState();
        await cancelActiveRun(pendingStart);
        identityMaps.clearAll();
        await options.storage.close();
        await options.storage.open(getStorageOpenOptions());
        try {
          await options.storage.clear();
        } finally {
          await options.storage.close();
        }
        loader.clear();
        missingModels.clear();
        history.clear();
        emitEvent({ pendingCount: 0, type: "outboxChange" });
      };

      await runLifecycleTeardown(doClear);
    },

    get clientId(): string {
      return orchestrator.getClientId();
    },

    get connectionState(): ConnectionState {
      return orchestrator.connectionState;
    },

    create<T extends Record<string, unknown>>(
      modelName: string,
      data: T,
      mutationOptions?: { onTransactionCreated?: (tx: Transaction) => void }
    ): Promise<T> {
      return mutations.create(modelName, data, mutationOptions);
    },

    delete(
      modelName: string,
      id: string,
      mutationOptions?: {
        original?: Record<string, unknown>;
        onTransactionCreated?: (tx: Transaction) => void;
      }
    ): Promise<void> {
      return mutations.delete(modelName, id, mutationOptions);
    },

    ensureModel<T>(modelName: string, id: string): Promise<T | null> {
      return ensureModelInternal(modelName, id);
    },

    get<T>(modelName: string, id: string): Promise<T | null> {
      return loader.getLocal<T>(modelName, id);
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
        // Wait for any in-progress stop() to complete before starting.
        // This prevents races where stop() clears state (clientId, storage)
        // while start() is trying to initialize (e.g. React StrictMode).
        if (stopPromise) {
          await stopPromise.catch(() => {
            /* noop */
          });
        }

        orchestrator.setConflictHandler(handleRejectedTransaction);

        try {
          await orchestrator.start();

          if (startVersion !== lifecycleVersion) {
            return;
          }

          const nextOutboxManager = createOutboxManager();
          hasStarted = true;

          await rehydrateOutboxWithSyncCursor(nextOutboxManager);
          await emitPendingCount({ awaitStart: false });
          // oxlint-disable-next-line no-void -- fire-and-forget background drain after startup
          void (async () => {
            try {
              await nextOutboxManager.processPendingTransactions();
              await emitPendingCount({ awaitStart: false });
            } catch (error) {
              if (startVersion !== lifecycleVersion) {
                return;
              }

              emitEvent({
                error:
                  error instanceof Error
                    ? error
                    : new Error("Failed to process pending transactions"),
                type: "syncError",
              });
            }
          })();
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
      const doStop = async (pendingStart: Promise<void> | null) => {
        await waitForInflightSends();
        clearOutboxManager();
        await cancelActiveRun(pendingStart);
        await orchestrator.closeStorage();
      };

      await runLifecycleTeardown(doStop);
    },

    async syncNow(): Promise<void> {
      await orchestrator.syncNow();
    },

    unarchive(
      modelName: string,
      id: string,
      mutationOptions?: UnarchiveTransactionOptions & {
        onTransactionCreated?: (tx: Transaction) => void;
      }
    ): Promise<void> {
      return mutations.unarchive(modelName, id, mutationOptions);
    },

    async undo(): Promise<void> {
      await history.undo(applyHistoryOperation);
    },

    update<T extends Record<string, unknown>>(
      modelName: string,
      id: string,
      changes: Partial<T>,
      mutationOptions?: {
        original?: Record<string, unknown>;
        onTransactionCreated?: (tx: Transaction) => void;
      }
    ): Promise<T> {
      return mutations.update(modelName, id, changes, mutationOptions);
    },

    yjs: yjsManagers,
  };

  return client;
};
