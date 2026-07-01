import type {
  ConnectionState,
  DeltaPacket,
  SyncClientState,
  SyncId,
  Transaction,
} from "@stratasync/core";
import { getOrCreateClientId, ModelRegistry } from "@stratasync/core";

import type { IdentityMapRegistry } from "./identity-map.js";
import { AsyncQueue } from "./internal/async-queue.js";
import { Gate } from "./internal/gate.js";
import type { OutboxManager } from "./outbox-manager.js";
import { BootstrapRunner } from "./sync/bootstrap-runner.js";
import type { SyncContext } from "./sync/context.js";
import { SyncCursor } from "./sync/cursor.js";
import { DeltaPipeline } from "./sync/delta-pipeline.js";
import {
  applyPendingTransactionsToIdentityMaps,
  areGroupsEqual,
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
  private readonly deltaPipeline: DeltaPipeline;

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
    this.deltaPipeline = new DeltaPipeline(this.context, {
      applyPendingOutboxTransactions: () =>
        this.applyPendingOutboxTransactions(),
      handleSyncGroupActions: (actions, nextSyncId) =>
        this.syncGroups.handleSyncGroupActions(actions, nextSyncId),
      processOutboxTransactions: () => this.processOutboxTransactions(),
      runBootstrap: (runToken) => this.bootstrapRunner.bootstrap(runToken),
    });

    this.attachTransportConnectionListener();
  }

  private buildContext(): SyncContext {
    return {
      cursor: this.cursor,
      deltaReplayGate: () => this.deltaReplayGate,
      emitEvent: this.emitEvent,
      getClientId: () => this.clientId,
      getConflictHandler: () => this.onTransactionConflict,
      getConnectionState: () => this.stateMachine.connectionState,
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

      // Local data is ready. Mark as syncing so the UI can render
      // cached content immediately without waiting for network ops.
      this.setState("syncing");

      // Network operations run in background, don't block start()
      const subscribeAfterSyncId = this.cursor.lastSyncId;
      this.deltaPipeline.startDeltaSubscription(subscribeAfterSyncId);
      const catchUp = this.deltaPipeline.catchUpMissedDeltas(
        subscribeAfterSyncId,
        activeRunToken
      );
      // oxlint-disable-next-line prefer-await-to-then, prefer-await-to-callbacks -- fire-and-forget error handler
      catchUp.catch((error) => {
        if (this.isRunActive(activeRunToken)) {
          this.handleSyncError(error);
        }
      });
      // No outbox drain here: outboxManager is attached only after start()
      // resolves (see client.ts createOutboxManager), so this call would be a
      // no-op at startup. The client owns the post-start drain via
      // synchronizeOutboxWithSyncCursor.
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

  private getActiveOutboxTransactions(): Promise<Transaction[]> {
    // Only the OutboxManager writes to the outbox, so when it is absent the
    // outbox is empty. Delegating keeps the active-state predicate in one place.
    return this.outboxManager?.getActiveTransactions() ?? Promise.resolve([]);
  }

  /**
   * Thin delegate to the shared pending-hydration helper. Retained as an
   * instance method so white-box tests can bind it; production code calls the
   * helper directly.
   */
  private applyPendingTransactionsToIdentityMaps(pending: Transaction[]): void {
    applyPendingTransactionsToIdentityMaps(this.identityMaps, pending);
  }

  private async emitOutboxCount(): Promise<void> {
    if (!this.emitEvent) {
      return;
    }
    // oxlint-disable-next-line no-await-expression-member
    const pendingCount = (await this.getActiveOutboxTransactions()).length;
    this.emitEvent({ pendingCount, type: "outboxChange" });
  }

  private handleSyncError(error: unknown): void {
    this.stateMachine.recordError(error);
  }

  private restartDeltaSubscription(afterSyncId: SyncId): Promise<void> {
    return this.deltaPipeline.restartDeltaSubscription(afterSyncId);
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
      await this.deltaPipeline.fetchAndApplyDeltaPages(this.cursor.lastSyncId);
    } catch (error) {
      if (
        await this.deltaPipeline.handleBootstrapRequired(
          error,
          this.deltaSubscription
        )
      ) {
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
          this.deltaPipeline.startDeltaSubscription(this.cursor.lastSyncId);
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
}
