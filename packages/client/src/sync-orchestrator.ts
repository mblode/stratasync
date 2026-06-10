import type {
  ConnectionState,
  DeltaPacket,
  RebaseConflict,
  RebaseOptions,
  SyncAction,
  SyncClientState,
  SyncId,
  Transaction,
} from "@stratasync/core";
import {
  applyDeltas,
  getOrCreateClientId,
  isSyncIdGreaterThan,
  ModelRegistry,
  rebaseOriginals,
  rebaseTransactions,
  resolveConflictEffect,
} from "@stratasync/core";

import type { IdentityMapRegistry } from "./identity-map.js";
import { AsyncQueue } from "./internal/async-queue.js";
import { Gate } from "./internal/gate.js";
import type { OutboxManager } from "./outbox-manager.js";
import { BootstrapRunner } from "./sync/bootstrap-runner.js";
import type { SyncContext } from "./sync/context.js";
import { SyncCursor } from "./sync/cursor.js";
import {
  applyPendingTransactionsToIdentityMaps,
  areGroupsEqual,
  touchPendingTransactionTargets,
} from "./sync/pending-hydration.js";
import { SyncStateMachine } from "./sync/state.js";
import { SyncGroupManager } from "./sync/sync-groups.js";
import type {
  StorageAdapter,
  StorageMeta,
  SyncClientEvent,
  SyncClientOptions,
  TransportAdapter,
} from "./types.js";
import { getModelKey } from "./utils.js";

interface DeferredMapOp {
  type: "merge" | "delete";
  modelName: string;
  id: string;
  data?: Record<string, unknown>;
  clientTxId?: string;
}

interface BootstrapRequiredError extends Error {
  code: "BOOTSTRAP_REQUIRED";
}

const isBootstrapRequiredError = (
  error: unknown
): error is BootstrapRequiredError =>
  error instanceof Error &&
  "code" in error &&
  error.code === "BOOTSTRAP_REQUIRED";

/**
 * Orchestrates the sync state machine
 */
export class SyncOrchestrator {
  private readonly storage: StorageAdapter;
  private readonly transport: TransportAdapter;
  private readonly identityMaps: IdentityMapRegistry;
  private outboxManager: OutboxManager | null = null;
  private readonly options: SyncClientOptions;
  private readonly registry: ModelRegistry;

  private readonly stateMachine: SyncStateMachine;

  private readonly schemaHash: string;
  private clientId = "";
  private readonly cursor: SyncCursor;
  private groups: string[] = [];
  private transportConnectionCleanup: (() => void) | null = null;

  private deltaSubscription: AsyncIterator<DeltaPacket> | null = null;
  /**
   * Orders delta packets against each other. Each packet's application is
   * funnelled through stateQueue too, so packets and mutations stay serialized
   * against one another (nested queues).
   */
  private packetQueue = new AsyncQueue();
  /**
   * Counting barrier: held while a multi-page catch-up replay is in flight so
   * live subscription packets wait until the replay finishes.
   */
  private deltaReplayGate = new Gate();
  /**
   * Serial executor for state-mutating work (mutations + delta application).
   */
  private stateQueue = new AsyncQueue();
  private running = false;
  private runToken = 0;
  private readonly emitEvent?: (event: SyncClientEvent) => void;
  private onTransactionConflict?: (tx: Transaction) => void;

  /** Conflict rollbacks deferred until the identity map batch. */
  private deferredConflictTxs: Transaction[] = [];

  private readonly context: SyncContext;
  private readonly syncGroups: SyncGroupManager;
  private readonly bootstrapRunner: BootstrapRunner;

  constructor(
    options: SyncClientOptions,
    identityMaps: IdentityMapRegistry,
    emitEvent?: (event: SyncClientEvent) => void
  ) {
    this.options = options;
    this.storage = options.storage;
    this.transport = options.transport;
    this.identityMaps = identityMaps;
    this.registry = new ModelRegistry(
      options.schema ?? ModelRegistry.snapshot()
    );
    this.schemaHash = this.registry.getSchemaHash();
    this.groups = options.groups ?? [];
    this.emitEvent = emitEvent;
    this.stateMachine = new SyncStateMachine(emitEvent);
    this.cursor = new SyncCursor(this.storage);

    this.context = this.buildContext();
    this.syncGroups = new SyncGroupManager(this.context, (afterSyncId) =>
      this.restartDeltaSubscription(afterSyncId)
    );
    this.bootstrapRunner = new BootstrapRunner(this.context);

    this.attachTransportConnectionListener();
  }

  private buildContext(): SyncContext {
    return {
      cursor: this.cursor,
      deltaReplayGate: () => this.deltaReplayGate,
      emitEvent: this.emitEvent,
      getClientId: () => this.clientId,
      getConflictHandler: () => this.onTransactionConflict,
      getDeferredConflictTxs: () => this.deferredConflictTxs,
      getDeltaSubscription: () => this.deltaSubscription,
      getGroups: () => this.groups,
      getOutboxManager: () => this.outboxManager,
      getRunToken: () => this.runToken,
      identityMaps: this.identityMaps,
      isRunActive: (runToken) => this.isRunActive(runToken),
      isRunning: () => this.running,
      options: this.options,
      packetQueue: () => this.packetQueue,
      recordError: (error) => this.handleSyncError(error),
      registry: this.registry,
      runWithStateLock: (operation) => this.runWithStateLock(operation),
      schemaHash: this.schemaHash,
      setDeferredConflictTxs: (txs) => {
        this.deferredConflictTxs = txs;
      },
      setDeltaSubscription: (subscription) => {
        this.deltaSubscription = subscription;
      },
      setGroups: (groups) => {
        this.groups = groups;
      },
      setState: (state) => this.setState(state),
      stateQueue: () => this.stateQueue,
      storage: this.storage,
      transport: this.transport,
    };
  }

  private attachTransportConnectionListener(): void {
    if (this.transportConnectionCleanup) {
      return;
    }

    this.transportConnectionCleanup = this.transport.onConnectionStateChange(
      (state) => {
        const previousState = this.stateMachine.connectionState;
        this.setConnectionState(state);
        this.handleConnectionChange(previousState, state);
      }
    );
  }

  setOutboxManager(outboxManager: OutboxManager | null): void {
    this.outboxManager = outboxManager;
  }

  setConflictHandler(handler: (tx: Transaction) => void): void {
    this.onTransactionConflict = handler;
  }

  /**
   * Gets the current sync state
   */
  get state(): SyncClientState {
    return this.stateMachine.state;
  }

  /**
   * Gets the current connection state
   */
  get connectionState(): ConnectionState {
    return this.stateMachine.connectionState;
  }

  /**
   * Gets the client ID
   */
  getClientId(): string {
    return this.clientId;
  }

  /**
   * Gets the last sync ID
   */
  getLastSyncId(): SyncId {
    return this.cursor.lastSyncId;
  }

  /**
   * Gets the first sync ID from the last full bootstrap
   */
  getFirstSyncId(): SyncId {
    return this.cursor.firstSyncId;
  }

  /**
   * Gets the last error
   */
  getLastError(): Error | null {
    return this.stateMachine.lastError;
  }

  /**
   * Starts the sync orchestrator
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.attachTransportConnectionListener();
    this.running = true;
    this.runToken += 1;
    const activeRunToken = this.runToken;

    this.emitEvent?.({ type: "syncStart" });
    this.setState("connecting");

    try {
      await this.openStorage();
      if (!this.isRunActive(activeRunToken)) {
        return;
      }
      const meta = await this.loadMetadata();
      if (!this.isRunActive(activeRunToken)) {
        return;
      }
      await this.configureGroups(meta);
      if (!this.isRunActive(activeRunToken)) {
        return;
      }
      await this.bootstrapIfNeeded(meta, activeRunToken);
      if (!this.isRunActive(activeRunToken)) {
        return;
      }
      await this.applyPendingOutboxTransactions();
      if (!this.isRunActive(activeRunToken)) {
        return;
      }

      // Local data is ready. Mark as syncing so the UI can render
      // cached content immediately without waiting for network ops.
      this.setState("syncing");

      // Network operations run in background, don't block start()
      const subscribeAfterSyncId = this.cursor.lastSyncId;
      this.startDeltaSubscription(subscribeAfterSyncId);
      // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
      this.catchUpMissedDeltas(subscribeAfterSyncId, activeRunToken).catch(
        // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
        (error) => {
          if (this.isRunActive(activeRunToken)) {
            this.handleSyncError(error);
          }
        }
      );
      // oxlint-disable-next-line prefer-await-to-then, prefer-await-to-callbacks -- fire-and-forget error handler
      this.processOutboxTransactions().catch((error) => {
        if (this.isRunActive(activeRunToken)) {
          this.handleSyncError(error);
        }
      });
    } catch (error) {
      if (this.isRunActive(activeRunToken)) {
        this.handleSyncError(error);
      }
      throw error;
    }
  }

  private async openStorage(): Promise<void> {
    await this.storage.open({
      name: this.options.dbName,
      schema: this.options.schema ?? this.registry.snapshot(),
      userId: this.options.userId,
      userVersion: this.options.userVersion,
      version: this.options.version,
    });
  }

  private async loadMetadata(): Promise<StorageMeta> {
    const meta = await this.storage.getMeta();
    this.clientId =
      meta.clientId ??
      getOrCreateClientId(`${this.options.dbName ?? "sync-db"}_client_id`);
    this.cursor.hydrate(meta);
    return meta;
  }

  private async configureGroups(meta: StorageMeta): Promise<void> {
    const storedGroups = meta.subscribedSyncGroups ?? [];
    const configuredGroups = this.options.groups ?? storedGroups;
    this.groups = configuredGroups.length > 0 ? configuredGroups : storedGroups;

    if (areGroupsEqual(storedGroups, this.groups)) {
      return;
    }

    this.cursor.resetFirstToLast();
    await this.storage.setMeta({
      firstSyncId: this.cursor.firstSyncId,
      subscribedSyncGroups: this.groups,
      updatedAt: Date.now(),
    });
  }

  private bootstrapIfNeeded(
    meta: StorageMeta,
    runToken: number
  ): Promise<void> {
    return this.bootstrapRunner.bootstrapIfNeeded(meta, runToken);
  }

  private async applyPendingOutboxTransactions(): Promise<void> {
    const pending = await this.getActiveOutboxTransactions();
    this.applyPendingTransactionsToIdentityMaps(pending);
  }

  private async processOutboxTransactions(): Promise<void> {
    if (!this.outboxManager) {
      return;
    }
    await this.outboxManager.completeUpToSyncId(this.cursor.lastSyncId);
    await this.outboxManager.processPendingTransactions();
    await this.emitOutboxCount();
  }

  /**
   * Best-effort catch-up for deltas created between bootstrap completion and
   * subscription readiness.
   */
  private async catchUpMissedDeltas(
    afterSyncId: SyncId,
    runToken: number
  ): Promise<void> {
    try {
      await this.fetchAndApplyDeltaPages(afterSyncId, {
        maxAttempts: 2,
        runToken,
        suppressFetchErrors: true,
      });
    } catch (error) {
      if (this.isRunActive(runToken)) {
        if (await this.handleBootstrapRequired(error, this.deltaSubscription)) {
          return;
        }
        this.handleSyncError(error);
      }
    }
  }

  private async fetchAndApplyDeltaPages(
    afterSyncId: SyncId,
    options: {
      maxAttempts?: number;
      runToken?: number;
      suppressFetchErrors?: boolean;
    } = {}
  ): Promise<void> {
    let nextAfterSyncId = afterSyncId;
    let releaseBarrier: (() => void) | null = null;

    try {
      while (true) {
        const packet = await this.fetchDeltaPage(nextAfterSyncId, options);
        if (!packet) {
          return;
        }

        if (
          options.runToken !== undefined &&
          !this.isRunActive(options.runToken)
        ) {
          return;
        }

        if (packet.hasMore && !releaseBarrier) {
          releaseBarrier = this.acquireDeltaReplayBarrier();
        }

        await this.enqueueDeltaPacket(packet);

        if (!packet.hasMore) {
          return;
        }

        if (!isSyncIdGreaterThan(packet.lastSyncId, nextAfterSyncId)) {
          return;
        }

        nextAfterSyncId = packet.lastSyncId;
      }
    } finally {
      releaseBarrier?.();
    }
  }

  private async fetchDeltaPage(
    afterSyncId: SyncId,
    options: {
      maxAttempts?: number;
      runToken?: number;
      suppressFetchErrors?: boolean;
    }
  ): Promise<DeltaPacket | null> {
    const maxAttempts = options.maxAttempts ?? 1;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (
        options.runToken !== undefined &&
        !this.isRunActive(options.runToken)
      ) {
        return null;
      }

      try {
        return await this.transport.fetchDeltas(
          afterSyncId,
          undefined,
          this.groups
        );
      } catch (error) {
        if (isBootstrapRequiredError(error)) {
          throw error;
        }
        const isLastAttempt = attempt >= maxAttempts - 1;
        if (
          isLastAttempt ||
          (options.runToken !== undefined &&
            !this.isRunActive(options.runToken))
        ) {
          if (options.suppressFetchErrors) {
            return null;
          }
          throw error;
        }
        await SyncOrchestrator.wait(300 * (attempt + 1));
      }
    }

    if (options.suppressFetchErrors) {
      return null;
    }
    return null;
  }

  private static wait(ms: number): Promise<void> {
    // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private isRunActive(runToken: number): boolean {
    return this.running && this.runToken === runToken;
  }

  /**
   * Stops the sync orchestrator
   */
  async stop(): Promise<void> {
    await this.reset();
    await this.storage.close();
  }

  async reset(): Promise<void> {
    this.running = false;
    this.runToken += 1;

    if (this.deltaSubscription) {
      try {
        await this.deltaSubscription.return?.();
      } catch {
        // Best-effort close while resetting.
      }
      this.deltaSubscription = null;
    }

    this.transportConnectionCleanup?.();
    this.transportConnectionCleanup = null;
    await this.transport.close();
    await this.packetQueue.drain();
    // Start fresh queues; a fresh Gate is open (no holds).
    this.packetQueue = new AsyncQueue();
    this.stateQueue = new AsyncQueue();
    this.deltaReplayGate = new Gate();
    this.deferredConflictTxs = [];
    this.clientId = "";
    this.cursor.reset();
    this.groups = this.options.groups ?? [];
    this.stateMachine.clearError();

    this.setConnectionState("disconnected");
    this.setState("disconnected");
  }

  /**
   * Forces an immediate sync
   */
  async syncNow(): Promise<void> {
    try {
      await this.fetchAndApplyDeltaPages(this.cursor.lastSyncId);
    } catch (error) {
      if (await this.handleBootstrapRequired(error, this.deltaSubscription)) {
        return;
      }
      throw error;
    }

    // Process pending outbox
    if (this.outboxManager) {
      await this.outboxManager.processPendingTransactions();
    }
  }

  /**
   * Subscribes to state changes
   */
  // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
  onStateChange(callback: (state: SyncClientState) => void): () => void {
    return this.stateMachine.onStateChange(callback);
  }

  /**
   * Subscribes to connection state changes
   */
  onConnectionStateChange(
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback: (state: ConnectionState) => void
  ): () => void {
    return this.stateMachine.onConnectionStateChange(callback);
  }

  runWithStateLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.stateQueue.run(operation);
  }

  /**
   * Performs initial bootstrap (delegates to BootstrapRunner).
   */
  private bootstrap(runToken: number): Promise<void> {
    return this.bootstrapRunner.bootstrap(runToken);
  }

  /**
   * Starts the delta subscription
   */
  private startDeltaSubscription(
    afterSyncId: SyncId = this.cursor.lastSyncId
  ): void {
    const subscription = this.transport.subscribe({
      afterSyncId,
      groups: this.groups,
    });

    this.deltaSubscription = subscription[Symbol.asyncIterator]();

    // Process deltas in background
    // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
    this.processDeltaStream().catch(() => {
      /* noop */
    });
  }

  private async restartDeltaSubscription(afterSyncId: SyncId): Promise<void> {
    const current = this.deltaSubscription;
    this.deltaSubscription = null;
    if (current) {
      try {
        await current.return?.();
      } catch {
        // Best-effort close of the existing iterator.
      }
    }
    this.startDeltaSubscription(afterSyncId);
  }

  /**
   * Processes the delta stream
   */
  private async processDeltaStream(): Promise<void> {
    const subscription = this.deltaSubscription;
    if (!subscription) {
      return;
    }

    try {
      while (this.running) {
        if (!this.isRunActive(this.runToken)) {
          break;
        }
        await this.deltaReplayGate.whenOpen();

        if (this.deltaSubscription !== subscription) {
          break;
        }

        const { value, done } = await subscription.next();
        if (done) {
          const shouldRestart =
            this.running && this.stateMachine.connectionState === "connected";
          if (this.deltaSubscription === subscription) {
            this.deltaSubscription = null;
          }
          if (shouldRestart) {
            this.startDeltaSubscription(this.cursor.lastSyncId);
          }
          break;
        }

        await this.deltaReplayGate.whenOpen();
        if (this.deltaSubscription !== subscription) {
          break;
        }
        await this.enqueueDeltaPacket(value);
      }
    } catch (error) {
      if (this.running) {
        if (await this.handleBootstrapRequired(error, subscription)) {
          return;
        }
        this.handleSyncError(error);
        // Try to reconnect
        setTimeout(() => {
          if (this.running && !this.deltaSubscription) {
            this.startDeltaSubscription();
          }
        }, 5000);
      }
    } finally {
      if (this.deltaSubscription === subscription) {
        this.deltaSubscription = null;
      }
    }
  }

  private async handleBootstrapRequired(
    error: unknown,
    subscription: AsyncIterator<DeltaPacket> | null
  ): Promise<boolean> {
    if (!isBootstrapRequiredError(error) || !this.isRunActive(this.runToken)) {
      return false;
    }

    if (subscription && this.deltaSubscription === subscription) {
      this.deltaSubscription = null;
    }

    try {
      await this.runWithStateLock(async () => {
        const activeRunToken = this.runToken;
        await this.bootstrap(activeRunToken);
        if (!this.isRunActive(activeRunToken)) {
          return;
        }
        await this.applyPendingOutboxTransactions();
      });

      if (!this.isRunActive(this.runToken)) {
        return true;
      }

      await this.processOutboxTransactions();
      if (this.running && !this.deltaSubscription) {
        this.startDeltaSubscription(this.cursor.lastSyncId);
      }
      if (this.running) {
        this.setState("syncing");
      }
      return true;
    } catch (recoveryError) {
      this.handleSyncError(recoveryError);
      return true;
    }
  }

  private enqueueDeltaPacket(packet: DeltaPacket): Promise<void> {
    // packetQueue serializes packets against each other; the nested state-lock
    // run keeps packet application serialized against mutations too.
    return this.packetQueue.run(() => {
      if (!this.running) {
        return;
      }
      return this.runWithStateLock(() => this.applyDeltaPacket(packet));
    });
  }

  private handleSyncError(error: unknown): void {
    this.stateMachine.recordError(error);
  }

  /**
   * Applies a delta packet to local state.
   *
   * Identity map mutations are deferred and applied in a single batch at the
   * end so that MobX observers never see an intermediate state where server
   * data has been written but pending local (outbox) changes have not yet been
   * re-applied.
   */
  private async applyDeltaPacket(packet: DeltaPacket): Promise<void> {
    const latestAppliedSyncId = this.cursor.lastSyncId;
    const nextActions = packet.actions.filter((action) =>
      isSyncIdGreaterThan(action.id, latestAppliedSyncId)
    );
    const filteredPacket: DeltaPacket = {
      ...packet,
      actions: nextActions,
    };

    if (filteredPacket.actions.length === 0) {
      await this.handleEmptyPacket(filteredPacket);
      return;
    }

    await this.storage.addSyncActions(filteredPacket.actions);

    const activeTransactions = await this.getActiveOutboxTransactions();

    // rebasePendingTransactions may detect conflicts and defer rollbacks
    // into this.deferredConflictTxs (processed inside the batch below).
    await this.rebasePendingTransactions(
      activeTransactions,
      filteredPacket.actions
    );
    await this.handleCoverageActions(filteredPacket.actions);
    await this.handleSyncGroupActions(
      filteredPacket.actions,
      filteredPacket.lastSyncId
    );

    // Write to storage and collect identity map ops (no MobX reactions yet).
    const deferredOps: DeferredMapOp[] = [];
    await this.collectDeferredDeltaOps(filteredPacket.actions, deferredOps);

    const syncCursorAdvanced = await this.updateSyncMetadata(
      filteredPacket.lastSyncId
    );

    // Snapshot the instance-local clientTxIds for echo suppression BEFORE
    // finishOutboxProcessing confirms (and therefore removes) them. Echo
    // suppression must see the pre-removal set so that own optimistic echoes
    // are still recognised in this same packet.
    // Reading from shared storage (IndexedDB) would instead include cross-tab
    // transactions, incorrectly suppressing identity map merges for them.
    const localTxIds = new Set<string>(
      this.outboxManager?.getLocalClientTxIds()
    );

    await this.finishOutboxProcessing(filteredPacket.actions);

    const ownClientTxIds = SyncOrchestrator.buildOwnClientTxIds(
      filteredPacket.actions,
      localTxIds
    );

    // Apply identity map changes in a single MobX action so observers
    // only see the final state (server data + pending local changes).
    // Deferred conflict rollbacks are processed here too, inside the
    // batch, so their intermediate deletes are never visible.
    const pending = await this.getActiveOutboxTransactions();

    this.identityMaps.batch(() => {
      touchPendingTransactionTargets(this.identityMaps, pending);

      // Process conflict rollbacks inside the batch.  This ensures that
      // the rollback's map.delete() and the subsequent server merge's
      // map.merge() are in the same runInAction, so microtask-scheduled
      // refreshSync only fires after both have completed.
      // Also remove rolled-back clientTxIds from ownClientTxIds so the
      // server merge's modelChange event emits properly for the model.
      for (const tx of this.deferredConflictTxs) {
        this.onTransactionConflict?.(tx);
        if (tx.clientTxId) {
          ownClientTxIds.delete(tx.clientTxId);
        }
      }
      this.deferredConflictTxs = [];

      for (const op of deferredOps) {
        const map = this.identityMaps.getMap(op.modelName);
        const isOwnOptimisticEcho =
          op.type === "merge" &&
          typeof op.clientTxId === "string" &&
          ownClientTxIds.has(op.clientTxId) &&
          map.has(op.id);
        if (isOwnOptimisticEcho) {
          continue;
        }
        if (op.type === "merge" && op.data) {
          map.merge(op.id, op.data, { serialized: true });
        } else if (op.type === "delete") {
          map.delete(op.id);
        }
      }
      this.applyPendingTransactionsToIdentityMaps(pending);
    });

    this.emitModelChangeEvents(filteredPacket.actions, ownClientTxIds);
    await this.emitOutboxCount();
    if (syncCursorAdvanced) {
      this.emitEvent?.({
        lastSyncId: this.cursor.lastSyncId,
        type: "syncComplete",
      });
    }
  }

  private async handleEmptyPacket(packet: DeltaPacket): Promise<void> {
    const syncCursorAdvanced = await this.updateSyncMetadata(packet.lastSyncId);
    if (this.outboxManager) {
      await this.outboxManager.completeUpToSyncId(this.cursor.lastSyncId);
    }
    await this.emitOutboxCount();
    if (syncCursorAdvanced) {
      this.emitEvent?.({
        lastSyncId: this.cursor.lastSyncId,
        type: "syncComplete",
      });
    }
  }

  /**
   * Build set of own-action keys for transactions that this local runtime
   * already applied optimistically and then saw confirmed by the server.
   *
   * Uses the instance-local set of clientTxIds (in-memory, not from shared
   * storage) so that cross-tab transactions sharing the same IndexedDB are
   * not incorrectly treated as own optimistic echoes.
   */
  private static buildOwnClientTxIds(
    actions: SyncAction[],
    localTxIds: ReadonlySet<string>
  ): Set<string> {
    const clientTxIds = new Set<string>();
    for (const action of actions) {
      if (action.clientTxId && localTxIds.has(action.clientTxId)) {
        clientTxIds.add(action.clientTxId);
      }
    }
    return clientTxIds;
  }

  private async getActiveOutboxTransactions(): Promise<Transaction[]> {
    // Only the OutboxManager writes to the outbox, so when it is absent the
    // outbox is empty. Delegating keeps the active-state predicate in one place.
    return (await this.outboxManager?.getActiveTransactions()) ?? [];
  }

  /**
   * Thin delegate to the shared pending-hydration helper. Retained as an
   * instance method so white-box tests can bind it; production code calls the
   * helper directly.
   */
  private applyPendingTransactionsToIdentityMaps(pending: Transaction[]): void {
    applyPendingTransactionsToIdentityMaps(this.identityMaps, pending);
  }

  /**
   * Creates a delta target that writes to storage immediately but collects
   * identity map operations for deferred application in a single batch.
   */
  private createDeferredDeltaTarget(ops: DeferredMapOp[], action: SyncAction) {
    return {
      delete: async (modelName: string, id: string) => {
        await this.storage.delete(modelName, id);
        ops.push({
          clientTxId: action.clientTxId,
          id,
          modelName,
          type: "delete",
        });
      },
      get: (modelName: string, id: string) =>
        this.storage.get<Record<string, unknown>>(modelName, id),
      patch: async (
        modelName: string,
        id: string,
        changes: Record<string, unknown>
      ) => {
        const existing = await this.storage.get<Record<string, unknown>>(
          modelName,
          id
        );
        const pk = this.registry.getPrimaryKey(modelName);
        const updated = existing
          ? { ...existing, ...changes }
          : { ...changes, [pk]: id };
        await this.storage.put(modelName, updated);
        ops.push({
          clientTxId: action.clientTxId,
          data: updated,
          id,
          modelName,
          type: "merge",
        });
      },
      put: async (
        modelName: string,
        id: string,
        data: Record<string, unknown>
      ) => {
        const pk = this.registry.getPrimaryKey(modelName);
        const row = { ...data, [pk]: id };
        await this.storage.put(modelName, row);
        ops.push({
          clientTxId: action.clientTxId,
          data: row,
          id,
          modelName,
          type: "merge",
        });
      },
    };
  }

  private async collectDeferredDeltaOps(
    actions: SyncAction[],
    ops: DeferredMapOp[]
  ): Promise<void> {
    for (const action of actions) {
      const deferredTarget = this.createDeferredDeltaTarget(ops, action);
      await applyDeltas(
        { actions: [action], lastSyncId: action.id },
        deferredTarget,
        this.registry,
        { mergeUpdates: true }
      );
    }
  }

  private async updateSyncMetadata(lastSyncId: SyncId): Promise<boolean> {
    const advanced = await this.cursor.advance(lastSyncId);
    if (advanced) {
      // Bound the sync-actions store: actions at or below the bootstrap floor
      // are superseded by the snapshot and never replayed.
      await this.storage.pruneSyncActions(this.cursor.firstSyncId);
    }
    return advanced;
  }

  private async finishOutboxProcessing(
    actions: SyncAction[]
  ): Promise<Set<string>> {
    const confirmedTxIds =
      (await this.outboxManager?.confirmFromActions(actions)) ??
      new Set<string>();
    if (this.outboxManager) {
      await this.outboxManager.completeUpToSyncId(this.cursor.lastSyncId);
    }
    return confirmedTxIds;
  }

  private static resolveModelChangeAction(
    action: SyncAction["action"]
  ): "insert" | "update" | "delete" | "archive" | "unarchive" | null {
    switch (action) {
      case "I": {
        return "insert";
      }
      case "U": {
        return "update";
      }
      case "D": {
        return "delete";
      }
      case "A": {
        return "archive";
      }
      case "V": {
        return "unarchive";
      }
      default: {
        return null;
      }
    }
  }

  private emitModelChangeEvents(
    actions: SyncAction[],
    ownClientTxIds: Set<string>
  ): void {
    // Deduplicate by modelName:modelId and skip local optimistic echoes only.
    // Cross-tab updates can share clientId and must still emit modelChange.
    const lastByKey = new Map<string, SyncAction>();
    for (const action of actions) {
      if (action.clientTxId && ownClientTxIds.has(action.clientTxId)) {
        continue;
      }
      const key = getModelKey(action.modelName, action.modelId);
      lastByKey.set(key, action);
    }

    for (const action of lastByKey.values()) {
      const eventAction = SyncOrchestrator.resolveModelChangeAction(
        action.action
      );
      if (!eventAction) {
        continue;
      }
      this.emitEvent?.({
        action: eventAction,
        modelId: action.modelId,
        modelName: action.modelName,
        type: "modelChange",
      });
    }
  }

  private async emitOutboxCount(): Promise<void> {
    if (!this.emitEvent) {
      return;
    }
    // oxlint-disable-next-line no-await-expression-member
    const pendingCount = (await this.getActiveOutboxTransactions()).length;
    this.emitEvent({ pendingCount, type: "outboxChange" });
  }

  private async rebasePendingTransactions(
    pending: Transaction[],
    actions: SyncAction[]
  ): Promise<void> {
    if (pending.length === 0) {
      return;
    }

    const rebaseOptions: RebaseOptions = {
      clientId: this.clientId,
      defaultResolution: this.options.rebaseStrategy ?? "server-wins",
      fieldLevelConflicts: this.options.fieldLevelConflicts ?? true,
    };

    const result = rebaseTransactions(pending, actions, rebaseOptions);

    for (const conflict of result.conflicts) {
      await this.handleConflict(conflict);
    }

    await this.updatePendingOriginals(result.pending, actions);
  }

  private async handleConflict(conflict: RebaseConflict): Promise<void> {
    const { localTransaction: tx } = conflict;
    const resolution =
      conflict.resolution === "manual" ? "server-wins" : conflict.resolution;
    const effect = resolveConflictEffect(conflict);

    if (effect.kind === "drop-local") {
      await this.storage.removeFromOutbox(tx.clientTxId);
      // Defer identity map rollback until the batch so it runs in the same
      // runInAction as the server merge.  Firing it here would delete the
      // item from the identity map and emit modelChange(delete) BEFORE the
      // deferred batch re-adds it, causing a visible flash of empty state.
      this.deferredConflictTxs.push(tx);
    } else if (effect.kind === "patch-original") {
      tx.original = effect.original;
      await this.storage.updateOutboxTransaction(tx.clientTxId, {
        original: effect.original,
      });
    }

    this.emitEvent?.({
      conflictType: conflict.conflictType,
      modelId: tx.modelId,
      modelName: tx.modelName,
      resolution,
      type: "rebaseConflict",
    });
  }

  private async updatePendingOriginals(
    pending: Transaction[],
    actions: SyncAction[]
  ): Promise<void> {
    const patches = rebaseOriginals(pending, actions);
    if (patches.length === 0) {
      return;
    }

    const txByClientTxId = new Map(pending.map((tx) => [tx.clientTxId, tx]));
    for (const patch of patches) {
      const tx = txByClientTxId.get(patch.clientTxId);
      if (tx) {
        tx.original = patch.original;
      }
      await this.storage.updateOutboxTransaction(patch.clientTxId, {
        original: patch.original,
      });
    }
  }

  private async handleCoverageActions(actions: SyncAction[]): Promise<void> {
    for (const action of actions) {
      if (action.action !== "C") {
        continue;
      }
      const { indexedKey } = action.data as Record<string, unknown>;
      const { keyValue } = action.data as Record<string, unknown>;
      if (typeof indexedKey === "string" && typeof keyValue === "string") {
        await this.storage.setPartialIndex(
          action.modelName,
          indexedKey,
          keyValue
        );
      }
    }
  }

  private handleSyncGroupActions(
    actions: SyncAction[],
    nextSyncId: SyncId
  ): Promise<void> {
    return this.syncGroups.handleSyncGroupActions(actions, nextSyncId);
  }

  /**
   * Handles connection state changes
   */
  private handleConnectionChange(
    previousState: ConnectionState,
    state: ConnectionState
  ): void {
    if (
      !this.running ||
      state !== "connected" ||
      previousState === "connected" ||
      this.stateMachine.state === "connecting" ||
      this.stateMachine.state === "bootstrapping"
    ) {
      return;
    }

    (async () => {
      try {
        await this.syncNow();
        if (this.running && !this.deltaSubscription) {
          this.startDeltaSubscription(this.cursor.lastSyncId);
        }
        if (this.running) {
          this.setState("syncing");
        }
      } catch (error) {
        if (this.running) {
          this.handleSyncError(
            error instanceof Error ? error : new Error("Failed to reconnect")
          );
        }
      }
    })();
  }

  private setState(state: SyncClientState): void {
    this.stateMachine.setState(state);
  }

  private setConnectionState(state: ConnectionState): void {
    this.stateMachine.setConnectionState(state);
  }

  /**
   * Gets the model registry
   */
  getRegistry(): ModelRegistry {
    return this.registry;
  }

  /**
   * Gets the storage adapter
   */
  getStorage(): StorageAdapter {
    return this.storage;
  }

  private acquireDeltaReplayBarrier(): () => void {
    return this.deltaReplayGate.hold();
  }
}
