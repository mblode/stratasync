import type {
  BootstrapMetadata,
  ConnectionState,
  DeltaPacket,
  ModelRow,
  RebaseConflict,
  RebaseOptions,
  SyncAction,
  SyncClientState,
  SyncId,
  Transaction,
} from "@stratasync/core";
import {
  applyDeltas,
  createArchivePayload,
  createUnarchivePatch,
  getOrCreateClientId,
  isSyncIdGreaterThan,
  ModelRegistry,
  readArchivedAt,
  rebaseTransactions,
  ZERO_SYNC_ID,
} from "@stratasync/core";

import type { IdentityMapRegistry } from "./identity-map.js";
import type { OutboxManager } from "./outbox-manager.js";
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

  private _state: SyncClientState = "disconnected";
  private _connectionState: ConnectionState = "disconnected";
  private readonly stateListeners = new Set<(state: SyncClientState) => void>();
  private readonly connectionListeners = new Set<
    (state: ConnectionState) => void
  >();

  private readonly schemaHash: string;
  private clientId = "";
  private lastSyncId: SyncId = ZERO_SYNC_ID;
  private lastError: Error | null = null;
  private firstSyncId: SyncId = ZERO_SYNC_ID;
  private groups: string[] = [];
  private transportConnectionCleanup: (() => void) | null = null;

  private deltaSubscription: AsyncIterator<DeltaPacket> | null = null;
  // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
  private deltaPacketQueue: Promise<void> = Promise.resolve();
  // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
  private deltaReplayBarrier: Promise<void> = Promise.resolve();
  // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
  private stateUpdateLock: Promise<void> = Promise.resolve();
  private running = false;
  private runToken = 0;
  private readonly emitEvent?: (event: SyncClientEvent) => void;
  private onTransactionConflict?: (tx: Transaction) => void;

  /** Conflict rollbacks deferred until the identity map batch. */
  private deferredConflictTxs: Transaction[] = [];

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

    this.attachTransportConnectionListener();
  }

  private attachTransportConnectionListener(): void {
    if (this.transportConnectionCleanup) {
      return;
    }

    this.transportConnectionCleanup = this.transport.onConnectionStateChange(
      (state) => {
        const previousState = this._connectionState;
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
    return this._state;
  }

  /**
   * Gets the current connection state
   */
  get connectionState(): ConnectionState {
    return this._connectionState;
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
    return this.lastSyncId;
  }

  /**
   * Gets the first sync ID from the last full bootstrap
   */
  getFirstSyncId(): SyncId {
    return this.firstSyncId;
  }

  /**
   * Gets the last error
   */
  getLastError(): Error | null {
    return this.lastError;
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
      const subscribeAfterSyncId = this.lastSyncId;
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
    this.lastSyncId = meta.lastSyncId ?? ZERO_SYNC_ID;
    this.firstSyncId = meta.firstSyncId ?? this.lastSyncId;
    return meta;
  }

  private async configureGroups(meta: StorageMeta): Promise<void> {
    const storedGroups = meta.subscribedSyncGroups ?? [];
    const configuredGroups = this.options.groups ?? storedGroups;
    this.groups = configuredGroups.length > 0 ? configuredGroups : storedGroups;

    if (SyncOrchestrator.areGroupsEqual(storedGroups, this.groups)) {
      return;
    }

    this.firstSyncId = this.lastSyncId;
    await this.storage.setMeta({
      firstSyncId: this.firstSyncId,
      subscribedSyncGroups: this.groups,
      updatedAt: Date.now(),
    });
  }

  private async bootstrapIfNeeded(
    meta: StorageMeta,
    runToken: number
  ): Promise<void> {
    if ((this.options.bootstrapMode ?? "auto") === "full") {
      await this.bootstrap(runToken);
      return;
    }

    const needsBootstrap = await this.shouldBootstrap(meta);
    if (!needsBootstrap) {
      await this.hydrateIdentityMaps(runToken);
      return;
    }

    await this.runBootstrapStrategy(runToken);
  }

  private async shouldBootstrap(meta: StorageMeta): Promise<boolean> {
    const bootstrapModels = this.registry.getBootstrapModelNames();
    const arePersisted = await this.areModelsPersisted(bootstrapModels);
    const storedHash = meta.schemaHash ?? "";
    // Treat an empty/missing hash as a mismatch. A valid bootstrap always
    // writes the hash, so an empty value means prior state is corrupt.
    const hasSchemaMismatch =
      storedHash.length === 0 || storedHash !== this.schemaHash;

    return (
      meta.bootstrapComplete === false ||
      hasSchemaMismatch ||
      this.lastSyncId === ZERO_SYNC_ID ||
      !arePersisted
    );
  }

  private async runBootstrapStrategy(runToken: number): Promise<void> {
    const bootstrapMode = this.options.bootstrapMode ?? "auto";
    if (bootstrapMode === "local") {
      await this.localBootstrap(runToken);
      return;
    }

    try {
      await this.bootstrap(runToken);
    } catch (error) {
      const canFallback =
        bootstrapMode === "auto" && (await this.hasLocalData());
      if (canFallback) {
        await this.localBootstrap(runToken);
        return;
      }
      throw error;
    }
  }

  private async applyPendingOutboxTransactions(): Promise<void> {
    const pending = await this.getActiveOutboxTransactions();
    await this.applyPendingTransactionsToIdentityMaps(pending);
  }

  private async processOutboxTransactions(): Promise<void> {
    if (!this.outboxManager) {
      return;
    }
    await this.outboxManager.completeUpToSyncId(this.lastSyncId);
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

  private shouldAbortBootstrap(runToken: number): boolean {
    return !this.isRunActive(runToken);
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
    await this.deltaPacketQueue.catch(() => {
      /* noop */
    });
    // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
    this.deltaPacketQueue = Promise.resolve();
    // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
    this.deltaReplayBarrier = Promise.resolve();
    // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
    this.stateUpdateLock = Promise.resolve();
    this.deferredConflictTxs = [];
    this.clientId = "";
    this.lastSyncId = ZERO_SYNC_ID;
    this.firstSyncId = ZERO_SYNC_ID;
    this.groups = this.options.groups ?? [];
    this.lastError = null;

    this.setConnectionState("disconnected");
    this.setState("disconnected");
  }

  /**
   * Forces an immediate sync
   */
  async syncNow(): Promise<void> {
    try {
      await this.fetchAndApplyDeltaPages(this.lastSyncId);
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
    this.stateListeners.add(callback);
    return () => {
      this.stateListeners.delete(callback);
    };
  }

  /**
   * Subscribes to connection state changes
   */
  onConnectionStateChange(
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback: (state: ConnectionState) => void
  ): () => void {
    this.connectionListeners.add(callback);
    return () => {
      this.connectionListeners.delete(callback);
    };
  }

  async runWithStateLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.stateUpdateLock;
    let releaseCurrent: (() => void) | undefined;
    // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    this.stateUpdateLock = (async () => {
      try {
        await previous;
      } catch {
        /* noop */
      }
      await current;
    })();
    try {
      await previous;
    } catch {
      /* noop */
    }

    try {
      return await operation();
    } finally {
      releaseCurrent?.();
    }
  }

  /**
   * Performs initial bootstrap
   */
  private async bootstrap(runToken: number): Promise<void> {
    this.setState("bootstrapping");

    // Stream bootstrap data
    const iterator = this.transport.bootstrap({
      onlyModels: this.registry.getBootstrapModelNames(),
      schemaHash: this.schemaHash,
      syncGroups: this.groups,
      type: "full",
    });

    const snapshot = await this.readBootstrapStream(iterator, runToken);
    if (!snapshot) {
      return;
    }
    if (this.shouldAbortBootstrap(runToken)) {
      return;
    }

    await this.commitBootstrapRows(snapshot.rows);

    const databaseVersion = this.applyBootstrapMetadata(snapshot.metadata);

    const persisted = await this.markBootstrapModelsPersisted(runToken);
    if (!persisted) {
      return;
    }

    await this.storage.setMeta({
      bootstrapComplete: true,
      databaseVersion,
      firstSyncId: this.firstSyncId,
      lastSyncAt: Date.now(),
      lastSyncId: this.lastSyncId,
      schemaHash: this.schemaHash,
      subscribedSyncGroups: this.groups,
      updatedAt: Date.now(),
    });
    this.emitEvent?.({ lastSyncId: this.lastSyncId, type: "syncComplete" });
  }

  private async readBootstrapStream(
    iterator: AsyncGenerator<ModelRow, BootstrapMetadata, unknown>,
    runToken: number
  ): Promise<{
    metadata: BootstrapMetadata;
    rows: ModelRow[];
  } | null> {
    const rows: ModelRow[] = [];
    while (true) {
      const { value, done } = await iterator.next();
      if (this.shouldAbortBootstrap(runToken)) {
        return null;
      }

      if (done) {
        if (!value) {
          throw new Error("Bootstrap completed without metadata");
        }
        return { metadata: value, rows };
      }

      rows.push(value);
    }
  }

  private async commitBootstrapRows(rows: ModelRow[]): Promise<void> {
    const ops = rows.map((row) => ({
      data: row.data,
      modelName: row.modelName,
      type: "put" as const,
    }));

    await this.storage.clear({ preserveOutbox: true });
    if (ops.length > 0) {
      await this.storage.writeBatch(ops);
    }

    this.identityMaps.batch(() => {
      this.identityMaps.clearAll();
      for (const row of rows) {
        const primaryKey = this.registry.getPrimaryKey(row.modelName);
        const id = row.data[primaryKey] as string;
        if (typeof id !== "string") {
          continue;
        }

        const map = this.identityMaps.getMap(row.modelName);
        map.set(id, row.data, { serialized: true });
      }
    });
  }

  private applyBootstrapMetadata(
    metadata: BootstrapMetadata
  ): number | undefined {
    if (metadata.lastSyncId === undefined) {
      throw new Error("Bootstrap metadata is missing lastSyncId");
    }

    this.lastSyncId = metadata.lastSyncId;
    this.firstSyncId = metadata.lastSyncId;
    this.groups =
      (metadata.subscribedSyncGroups?.length ?? 0) > 0
        ? metadata.subscribedSyncGroups
        : this.groups;

    return metadata.databaseVersion;
  }

  private async markBootstrapModelsPersisted(
    runToken: number
  ): Promise<boolean> {
    for (const modelName of this.registry.getBootstrapModelNames()) {
      await this.storage.setModelPersistence(modelName, true);
      if (this.shouldAbortBootstrap(runToken)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Performs a local-only bootstrap using existing storage data.
   */
  private async localBootstrap(runToken: number): Promise<void> {
    this.setState("bootstrapping");
    await this.hydrateIdentityMaps(runToken);
  }

  /**
   * Checks whether any hydrated models exist in storage.
   */
  private async hasLocalData(): Promise<boolean> {
    for (const modelName of this.registry.getBootstrapModelNames()) {
      const count = await this.storage.count(modelName);
      if (count > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Loads existing data from storage into identity maps
   */
  private async hydrateIdentityMaps(runToken: number): Promise<void> {
    for (const modelName of this.getEagerHydrationModelNames()) {
      if (!this.isRunActive(runToken)) {
        return;
      }
      const rows =
        await this.storage.getAll<Record<string, unknown>>(modelName);
      if (!this.isRunActive(runToken)) {
        return;
      }
      const map = this.identityMaps.getMap(modelName);
      const primaryKey = this.registry.getPrimaryKey(modelName);

      for (const row of rows) {
        if (!this.isRunActive(runToken)) {
          return;
        }
        const id = row[primaryKey] as string;
        if (typeof id !== "string") {
          continue;
        }
        map.set(id, row, { serialized: true });
      }
    }
  }

  private getEagerHydrationModelNames(): string[] {
    return this.registry
      .getAllModels()
      .filter(
        (model) =>
          model.loadStrategy === "instant" ||
          (model.loadStrategy === "partial" && model.partialLoadMode === "full")
      )
      .map((model) => model.name ?? "");
  }

  private async areModelsPersisted(modelNames: string[]): Promise<boolean> {
    for (const modelName of modelNames) {
      const persistence = await this.storage.getModelPersistence(modelName);
      if (!persistence.persisted) {
        return false;
      }
    }
    return true;
  }

  private static areGroupsEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) {
      return false;
    }
    const setA = new Set(a);
    if (setA.size !== b.length) {
      return false;
    }
    for (const value of b) {
      if (!setA.has(value)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Starts the delta subscription
   */
  private startDeltaSubscription(afterSyncId: SyncId = this.lastSyncId): void {
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
        await this.deltaReplayBarrier;

        if (this.deltaSubscription !== subscription) {
          break;
        }

        const { value, done } = await subscription.next();
        if (done) {
          const shouldRestart =
            this.running && this._connectionState === "connected";
          if (this.deltaSubscription === subscription) {
            this.deltaSubscription = null;
          }
          if (shouldRestart) {
            this.startDeltaSubscription(this.lastSyncId);
          }
          break;
        }

        await this.deltaReplayBarrier;
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
        this.startDeltaSubscription(this.lastSyncId);
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
    const previous = this.deltaPacketQueue;
    const run = (async () => {
      await previous;
      if (!this.running) {
        return;
      }
      await this.runWithStateLock(async () => {
        await this.applyDeltaPacket(packet);
      });
    })();
    // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
    this.deltaPacketQueue = run.catch(() => {
      /* noop */
    });
    return run;
  }

  private handleSyncError(error: unknown): void {
    this.lastError = error instanceof Error ? error : new Error(String(error));
    this.emitEvent?.({ error: this.lastError, type: "syncError" });
    this.setState("error");
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
    const latestAppliedSyncId = this.lastSyncId;
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

    await this.finishOutboxProcessing(filteredPacket.actions);

    // Use the instance-local set of clientTxIds for echo suppression.
    // Reading from shared storage (IndexedDB) would include cross-tab
    // transactions, incorrectly suppressing identity map merges for them.
    const localTxIds =
      this.outboxManager?.getLocalClientTxIds() ?? new Set<string>();
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
      this.touchPendingTransactionTargets(pending);

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
      this.emitEvent?.({ lastSyncId: this.lastSyncId, type: "syncComplete" });
    }
  }

  private async handleEmptyPacket(packet: DeltaPacket): Promise<void> {
    const syncCursorAdvanced = await this.updateSyncMetadata(packet.lastSyncId);
    if (this.outboxManager) {
      await this.outboxManager.completeUpToSyncId(this.lastSyncId);
    }
    await this.emitOutboxCount();
    if (syncCursorAdvanced) {
      this.emitEvent?.({ lastSyncId: this.lastSyncId, type: "syncComplete" });
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
    const outbox = await this.storage.getOutbox();
    return outbox.filter(
      (tx) =>
        tx.state === "queued" ||
        tx.state === "sent" ||
        tx.state === "awaitingSync"
    );
  }

  private touchPendingTransactionTargets(pending: Transaction[]): void {
    for (const tx of pending) {
      const map = this.identityMaps.getMap<Record<string, unknown>>(
        tx.modelName
      );
      map.get(tx.modelId);
    }
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
    if (!isSyncIdGreaterThan(lastSyncId, this.lastSyncId)) {
      return false;
    }
    this.lastSyncId = lastSyncId;
    await this.storage.setMeta({
      lastSyncAt: Date.now(),
      lastSyncId: this.lastSyncId,
      updatedAt: Date.now(),
    });
    return true;
  }

  private async finishOutboxProcessing(
    actions: SyncAction[]
  ): Promise<Set<string>> {
    const confirmedTxIds = await this.removeConfirmedTransactions(actions);
    const redundantTxIds =
      await this.removeRedundantCreateTransactions(actions);
    if (this.outboxManager) {
      await this.outboxManager.completeUpToSyncId(this.lastSyncId);
    }
    for (const id of redundantTxIds) {
      confirmedTxIds.add(id);
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

    if (resolution === "server-wins") {
      await this.storage.removeFromOutbox(tx.clientTxId);
      // Defer identity map rollback until the batch so it runs in the same
      // runInAction as the server merge.  Firing it here would delete the
      // item from the identity map and emit modelChange(delete) BEFORE the
      // deferred batch re-adds it, causing a visible flash of empty state.
      this.deferredConflictTxs.push(tx);
    } else if (
      (resolution === "client-wins" || resolution === "merge") &&
      (tx.action === "U" || tx.action === "A" || tx.action === "V")
    ) {
      const updatedOriginal = {
        ...tx.original,
        ...conflict.serverAction.data,
      };
      tx.original = updatedOriginal;
      await this.storage.updateOutboxTransaction(tx.clientTxId, {
        original: updatedOriginal,
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
    const actionsByKey = SyncOrchestrator.buildActionsByKey(actions);

    for (const tx of pending) {
      if (tx.action !== "U" && tx.action !== "A" && tx.action !== "V") {
        continue;
      }
      const key = getModelKey(tx.modelName, tx.modelId);
      const related = actionsByKey.get(key);
      if (!related) {
        continue;
      }
      const updatedOriginal = SyncOrchestrator.getUpdatedOriginal(tx, related);
      if (!updatedOriginal) {
        continue;
      }
      tx.original = updatedOriginal;
      await this.storage.updateOutboxTransaction(tx.clientTxId, {
        original: updatedOriginal,
      });
    }
  }

  private static buildActionsByKey(
    actions: SyncAction[]
  ): Map<string, SyncAction[]> {
    const actionsByKey = new Map<string, SyncAction[]>();
    for (const action of actions) {
      const key = getModelKey(action.modelName, action.modelId);
      const existing = actionsByKey.get(key) ?? [];
      existing.push(action);
      actionsByKey.set(key, existing);
    }
    return actionsByKey;
  }

  private static shouldRebaseAction(action: SyncAction["action"]): boolean {
    return action === "U" || action === "I" || action === "V" || action === "C";
  }

  private static getUpdatedOriginal(
    tx: Transaction,
    related: SyncAction[]
  ): Record<string, unknown> | null {
    const original = { ...tx.original };
    let updated = false;

    for (const action of related) {
      if (!SyncOrchestrator.shouldRebaseAction(action.action)) {
        continue;
      }
      for (const field of Object.keys(tx.payload)) {
        if (field in action.data) {
          original[field] = action.data[field];
          updated = true;
        }
      }
    }

    return updated ? original : null;
  }

  /**
   * Re-applies pending outbox transactions to identity maps after a server sync.
   * This intentionally differs from rollbackTransaction (which inverts) and
   * applyDeltas (which writes to storage). It re-applies forward to restore
   * optimistic state on top of newly-synced server data.
   */
  private applyPendingTransactionsToIdentityMaps(pending: Transaction[]): void {
    if (pending.length === 0) {
      return;
    }

    for (const tx of pending) {
      const map = this.identityMaps.getMap<Record<string, unknown>>(
        tx.modelName
      );

      switch (tx.action) {
        case "I": {
          // Only re-create if the model was removed (e.g. conflict rollback).
          // If it already exists, the optimistic insert is still valid and
          // re-merging the full create payload would overwrite field changes
          // from optimistic updates whose outbox writes are still in-flight.
          if (!map.has(tx.modelId)) {
            map.merge(tx.modelId, tx.payload);
          }
          break;
        }
        case "U": {
          if (map.has(tx.modelId)) {
            map.merge(tx.modelId, tx.payload);
          }
          break;
        }
        case "D": {
          map.delete(tx.modelId);
          break;
        }
        case "A": {
          if (map.has(tx.modelId)) {
            map.merge(
              tx.modelId,
              createArchivePayload(readArchivedAt(tx.payload))
            );
          }
          break;
        }
        case "V": {
          const existing = map.get(tx.modelId);
          if (existing) {
            const updated = {
              ...existing,
              ...createUnarchivePatch(),
            };
            map.set(tx.modelId, updated);
          }
          break;
        }
        default: {
          break;
        }
      }
    }
  }

  private async removeConfirmedTransactions(
    actions: SyncAction[]
  ): Promise<Set<string>> {
    const confirmed = new Set<string>();
    const clientTxIds = actions
      .map((action) => action.clientTxId)
      .filter((value): value is string => typeof value === "string");

    if (clientTxIds.length === 0) {
      return confirmed;
    }

    const outbox = await this.storage.getOutbox();
    const known = new Set(outbox.map((tx) => tx.clientTxId));
    for (const clientTxId of clientTxIds) {
      if (known.has(clientTxId)) {
        await this.storage.removeFromOutbox(clientTxId);
        confirmed.add(clientTxId);
      }
    }
    return confirmed;
  }

  private async removeRedundantCreateTransactions(
    actions: SyncAction[]
  ): Promise<Set<string>> {
    const redundant = new Set<string>();
    const createsByModelId = new Map<
      string,
      {
        clientTxIds: Set<string>;
        hasLegacyCreate: boolean;
      }
    >();

    for (const action of actions) {
      if (action.action !== "I") {
        continue;
      }

      const entry = createsByModelId.get(action.modelId) ?? {
        clientTxIds: new Set<string>(),
        hasLegacyCreate: false,
      };
      if (typeof action.clientTxId === "string") {
        entry.clientTxIds.add(action.clientTxId);
      } else {
        entry.hasLegacyCreate = true;
      }
      createsByModelId.set(action.modelId, entry);
    }

    if (createsByModelId.size === 0) {
      return redundant;
    }
    const outbox = await this.storage.getOutbox();

    for (const tx of outbox) {
      if (tx.action !== "I") {
        continue;
      }

      const entry = createsByModelId.get(tx.modelId);
      if (!entry) {
        continue;
      }
      if (!entry.hasLegacyCreate && !entry.clientTxIds.has(tx.clientTxId)) {
        continue;
      }

      await this.storage.removeFromOutbox(tx.clientTxId);
      redundant.add(tx.clientTxId);
    }
    return redundant;
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

  private async handleSyncGroupActions(
    actions: SyncAction[],
    nextSyncId: SyncId
  ): Promise<void> {
    const groupUpdates: string[][] = [];
    for (const action of actions) {
      if (action.action !== "G" && action.action !== "S") {
        continue;
      }
      const data = action.data as Record<string, unknown>;
      const groups = data.subscribedSyncGroups;
      if (Array.isArray(groups)) {
        const filtered = groups.filter(
          (group): group is string => typeof group === "string"
        );
        groupUpdates.push(filtered);
      }
    }

    if (groupUpdates.length === 0) {
      return;
    }

    const nextGroups = groupUpdates.at(-1);
    if (
      !nextGroups ||
      SyncOrchestrator.areGroupsEqual(this.groups, nextGroups)
    ) {
      return;
    }

    const currentSet = new Set(this.groups);
    const nextSet = new Set(nextGroups);
    const addedGroups = nextGroups.filter((group) => !currentSet.has(group));
    const removedGroups = this.groups.filter((group) => !nextSet.has(group));

    if (addedGroups.length > 0) {
      await this.bootstrapSyncGroups(addedGroups, nextSyncId, this.runToken);
    }

    if (removedGroups.length > 0) {
      await this.removeSyncGroupData(removedGroups);
    }

    this.groups = nextGroups;
    this.firstSyncId = nextSyncId;
    await this.storage.setMeta({
      firstSyncId: this.firstSyncId,
      subscribedSyncGroups: this.groups,
      updatedAt: Date.now(),
    });

    const pending = await this.getActiveOutboxTransactions();
    this.identityMaps.batch(() => {
      this.touchPendingTransactionTargets(pending);
      this.applyPendingTransactionsToIdentityMaps(pending);
    });

    if (this.running) {
      await this.restartDeltaSubscription(nextSyncId);
    }
  }

  private async bootstrapSyncGroups(
    groups: string[],
    firstSyncId: SyncId,
    runToken: number
  ): Promise<void> {
    const iterator = this.transport.bootstrap({
      firstSyncId,
      noSyncPackets: true,
      schemaHash: this.schemaHash,
      syncGroups: groups,
      type: "partial",
    });

    const hydrated = new Set(this.getEagerHydrationModelNames());

    const cancelIfStale = async (): Promise<boolean> => {
      if (this.isRunActive(runToken)) {
        return false;
      }

      try {
        await iterator.return?.({ subscribedSyncGroups: groups });
      } catch {
        // Best-effort cleanup when cancellation races with bootstrap.
      }

      return true;
    };

    while (true) {
      if (await cancelIfStale()) {
        return;
      }

      const { value, done } = await iterator.next();
      if (await cancelIfStale()) {
        return;
      }

      if (done) {
        break;
      }

      const row = value;
      const primaryKey = this.registry.getPrimaryKey(row.modelName);
      const id = row.data[primaryKey] as string;
      if (typeof id !== "string") {
        continue;
      }
      await this.storage.put(row.modelName, row.data);
      if (await cancelIfStale()) {
        return;
      }

      if (hydrated.has(row.modelName)) {
        const map = this.identityMaps.getMap(row.modelName);
        map.merge(id, row.data, { serialized: true });
      }
    }
  }

  private async removeSyncGroupData(groups: string[]): Promise<void> {
    if (groups.length === 0) {
      return;
    }

    for (const model of this.registry.getAllModels()) {
      const modelName = model.name ?? "";
      const { groupKey } = model;
      if (!(modelName && groupKey)) {
        continue;
      }

      const primaryKey = model.primaryKey ?? "id";
      const map = this.identityMaps.getMap<Record<string, unknown>>(modelName);

      for (const group of groups) {
        const rows = await this.storage.getByIndex<Record<string, unknown>>(
          modelName,
          groupKey,
          group
        );

        for (const row of rows) {
          const id = row[primaryKey] as string;
          if (typeof id !== "string") {
            continue;
          }
          await this.storage.delete(modelName, id);
          map.delete(id);
          this.emitEvent?.({
            action: "delete",
            modelId: id,
            modelName,
            type: "modelChange",
          });
        }
      }
    }
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
      this._state === "connecting" ||
      this._state === "bootstrapping"
    ) {
      return;
    }

    (async () => {
      try {
        await this.syncNow();
        if (this.running && !this.deltaSubscription) {
          this.startDeltaSubscription(this.lastSyncId);
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

  /**
   * Sets the sync state
   */
  private setState(state: SyncClientState): void {
    if (this._state !== state) {
      this._state = state;
      if (state !== "error") {
        this.lastError = null;
      }
      this.emitEvent?.({ state, type: "stateChange" });
      for (const listener of this.stateListeners) {
        listener(state);
      }
    }
  }

  /**
   * Sets the connection state
   */
  private setConnectionState(state: ConnectionState): void {
    if (this._connectionState !== state) {
      this._connectionState = state;
      this.emitEvent?.({ state, type: "connectionChange" });
      for (const listener of this.connectionListeners) {
        listener(state);
      }
    }
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
    const previousBarrier = this.deltaReplayBarrier;
    // eslint-disable-next-line unicorn/consistent-function-scoping -- releaseBarrier is reassigned inside Promise constructor
    let releaseBarrier = (): void => undefined;

    // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
    const currentBarrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    this.deltaReplayBarrier = (async () => {
      await previousBarrier;
      await currentBarrier;
    })();

    return () => {
      releaseBarrier();
    };
  }
}
