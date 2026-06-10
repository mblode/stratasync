// oxlint-disable prefer-await-to-then, prefer-await-to-callbacks -- this module
// drives fire-and-forget background loops and registers iterator callbacks.
import type {
  DeltaPacket,
  RebaseConflict,
  RebaseOptions,
  SyncAction,
  SyncId,
  Transaction,
} from "@stratasync/core";
import {
  applyDeltas,
  isSyncIdGreaterThan,
  rebaseOriginals,
  rebaseTransactions,
  resolveConflictEffect,
} from "@stratasync/core";

import { getModelKey } from "../utils.js";
import type { SyncContext } from "./context.js";
import {
  applyPendingTransactionsToIdentityMaps,
  touchPendingTransactionTargets,
} from "./pending-hydration.js";

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

const wait = (ms: number): Promise<void> =>
  // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Collaborators the pipeline calls back into for cross-cutting work the
 * orchestrator still coordinates (bootstrap recovery, sync-group handling,
 * outbox lifecycle).
 */
export interface DeltaPipelineDeps {
  /** Runs a full bootstrap for the given run token. */
  runBootstrap(runToken: number): Promise<void>;
  /** Re-applies pending outbox transactions to identity maps. */
  applyPendingOutboxTransactions(): Promise<void>;
  /** Completes + processes pending outbox transactions, emits the count. */
  processOutboxTransactions(): Promise<void>;
  /** Handles sync-group membership changes carried by delta actions. */
  handleSyncGroupActions(
    actions: SyncAction[],
    nextSyncId: SyncId
  ): Promise<void>;
}

/**
 * Owns the live delta stream: subscription lifecycle, catch-up paging, the
 * replay gate, packet/state queue wiring, applyDeltaPacket (including deferred
 * identity-map ops, echo suppression, rebase/conflict handling), and
 * BOOTSTRAP_REQUIRED recovery. Holds no run token of its own; reads the
 * orchestrator's via the context after every await.
 */
export class DeltaPipeline {
  private readonly ctx: SyncContext;
  private readonly deps: DeltaPipelineDeps;

  constructor(ctx: SyncContext, deps: DeltaPipelineDeps) {
    this.ctx = ctx;
    this.deps = deps;
  }

  private getActiveOutboxTransactions(): Promise<Transaction[]> {
    return (
      this.ctx.getOutboxManager()?.getActiveTransactions() ??
      Promise.resolve([])
    );
  }

  /**
   * Starts the delta subscription.
   */
  startDeltaSubscription(
    afterSyncId: SyncId = this.ctx.cursor.lastSyncId
  ): void {
    const subscription = this.ctx.transport.subscribe({
      afterSyncId,
      groups: this.ctx.getGroups(),
    });

    this.ctx.setDeltaSubscription(subscription[Symbol.asyncIterator]());

    // Process deltas in background
    this.processDeltaStream().catch(() => {
      /* noop */
    });
  }

  async restartDeltaSubscription(afterSyncId: SyncId): Promise<void> {
    const current = this.ctx.getDeltaSubscription();
    this.ctx.setDeltaSubscription(null);
    if (current) {
      try {
        await current.return?.();
      } catch {
        // Best-effort close of the existing iterator.
      }
    }
    this.startDeltaSubscription(afterSyncId);
  }

  async stopSubscription(): Promise<void> {
    const subscription = this.ctx.getDeltaSubscription();
    if (!subscription) {
      return;
    }
    try {
      await subscription.return?.();
    } catch {
      // Best-effort close while resetting.
    }
    this.ctx.setDeltaSubscription(null);
  }

  /**
   * Processes the delta stream.
   */
  private async processDeltaStream(): Promise<void> {
    const subscription = this.ctx.getDeltaSubscription();
    if (!subscription) {
      return;
    }

    try {
      while (this.ctx.isRunning()) {
        if (!this.ctx.isRunActive(this.ctx.getRunToken())) {
          break;
        }
        await this.ctx.deltaReplayGate().whenOpen();

        if (this.ctx.getDeltaSubscription() !== subscription) {
          break;
        }

        const { value, done } = await subscription.next();
        if (done) {
          const shouldRestart =
            this.ctx.isRunning() &&
            this.ctx.getConnectionState() === "connected";
          if (this.ctx.getDeltaSubscription() === subscription) {
            this.ctx.setDeltaSubscription(null);
          }
          if (shouldRestart) {
            this.startDeltaSubscription(this.ctx.cursor.lastSyncId);
          }
          break;
        }

        await this.ctx.deltaReplayGate().whenOpen();
        if (this.ctx.getDeltaSubscription() !== subscription) {
          break;
        }
        await this.enqueueDeltaPacket(value);
      }
    } catch (error) {
      if (this.ctx.isRunning()) {
        if (await this.handleBootstrapRequired(error, subscription)) {
          return;
        }
        this.ctx.recordError(error);
        // Try to reconnect
        setTimeout(() => {
          if (this.ctx.isRunning() && !this.ctx.getDeltaSubscription()) {
            this.startDeltaSubscription();
          }
        }, 5000);
      }
    } finally {
      if (this.ctx.getDeltaSubscription() === subscription) {
        this.ctx.setDeltaSubscription(null);
      }
    }
  }

  async handleBootstrapRequired(
    error: unknown,
    subscription: AsyncIterator<DeltaPacket> | null
  ): Promise<boolean> {
    if (
      !isBootstrapRequiredError(error) ||
      !this.ctx.isRunActive(this.ctx.getRunToken())
    ) {
      return false;
    }

    if (subscription && this.ctx.getDeltaSubscription() === subscription) {
      this.ctx.setDeltaSubscription(null);
    }

    try {
      await this.ctx.runWithStateLock(async () => {
        const activeRunToken = this.ctx.getRunToken();
        await this.deps.runBootstrap(activeRunToken);
        if (!this.ctx.isRunActive(activeRunToken)) {
          return;
        }
        await this.deps.applyPendingOutboxTransactions();
      });

      if (!this.ctx.isRunActive(this.ctx.getRunToken())) {
        return true;
      }

      await this.deps.processOutboxTransactions();
      if (this.ctx.isRunning() && !this.ctx.getDeltaSubscription()) {
        this.startDeltaSubscription(this.ctx.cursor.lastSyncId);
      }
      if (this.ctx.isRunning()) {
        this.ctx.setState("syncing");
      }
      return true;
    } catch (recoveryError) {
      this.ctx.recordError(recoveryError);
      return true;
    }
  }

  /**
   * Best-effort catch-up for deltas created between bootstrap completion and
   * subscription readiness.
   */
  async catchUpMissedDeltas(
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
      if (this.ctx.isRunActive(runToken)) {
        if (
          await this.handleBootstrapRequired(
            error,
            this.ctx.getDeltaSubscription()
          )
        ) {
          return;
        }
        this.ctx.recordError(error);
      }
    }
  }

  async fetchAndApplyDeltaPages(
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
          !this.ctx.isRunActive(options.runToken)
        ) {
          return;
        }

        if (packet.hasMore && !releaseBarrier) {
          releaseBarrier = this.ctx.deltaReplayGate().hold();
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
        !this.ctx.isRunActive(options.runToken)
      ) {
        return null;
      }

      try {
        return await this.ctx.transport.fetchDeltas(
          afterSyncId,
          undefined,
          this.ctx.getGroups()
        );
      } catch (error) {
        if (isBootstrapRequiredError(error)) {
          throw error;
        }
        const isLastAttempt = attempt >= maxAttempts - 1;
        if (
          isLastAttempt ||
          (options.runToken !== undefined &&
            !this.ctx.isRunActive(options.runToken))
        ) {
          if (options.suppressFetchErrors) {
            return null;
          }
          throw error;
        }
        await wait(300 * (attempt + 1));
      }
    }

    if (options.suppressFetchErrors) {
      return null;
    }
    return null;
  }

  private enqueueDeltaPacket(packet: DeltaPacket): Promise<void> {
    // packetQueue serializes packets against each other; the nested state-lock
    // run keeps packet application serialized against mutations too.
    return this.ctx.packetQueue().run(() => {
      if (!this.ctx.isRunning()) {
        return;
      }
      return this.ctx.runWithStateLock(() => this.applyDeltaPacket(packet));
    });
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
    const latestAppliedSyncId = this.ctx.cursor.lastSyncId;
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

    await this.ctx.storage.addSyncActions(filteredPacket.actions);

    const activeTransactions = await this.getActiveOutboxTransactions();

    // rebasePendingTransactions may detect conflicts and defer rollbacks
    // into the context's deferred-conflict list (processed in the batch below).
    await this.rebasePendingTransactions(
      activeTransactions,
      filteredPacket.actions
    );
    await this.handleCoverageActions(filteredPacket.actions);
    await this.deps.handleSyncGroupActions(
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
      this.ctx.getOutboxManager()?.getLocalClientTxIds()
    );

    await this.finishOutboxProcessing(filteredPacket.actions);

    const ownClientTxIds = DeltaPipeline.buildOwnClientTxIds(
      filteredPacket.actions,
      localTxIds
    );

    // Apply identity map changes in a single MobX action so observers
    // only see the final state (server data + pending local changes).
    // Deferred conflict rollbacks are processed here too, inside the
    // batch, so their intermediate deletes are never visible.
    const pending = await this.getActiveOutboxTransactions();

    this.ctx.identityMaps.batch(() => {
      touchPendingTransactionTargets(this.ctx.identityMaps, pending);

      // Process conflict rollbacks inside the batch.  This ensures that
      // the rollback's map.delete() and the subsequent server merge's
      // map.merge() are in the same runInAction, so microtask-scheduled
      // refreshSync only fires after both have completed.
      // Also remove rolled-back clientTxIds from ownClientTxIds so the
      // server merge's modelChange event emits properly for the model.
      const deferredConflictTxs = this.ctx.getDeferredConflictTxs();
      const conflictHandler = this.ctx.getConflictHandler();
      for (const tx of deferredConflictTxs) {
        conflictHandler?.(tx);
        if (tx.clientTxId) {
          ownClientTxIds.delete(tx.clientTxId);
        }
      }
      this.ctx.setDeferredConflictTxs([]);

      for (const op of deferredOps) {
        const map = this.ctx.identityMaps.getMap(op.modelName);
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
      applyPendingTransactionsToIdentityMaps(this.ctx.identityMaps, pending);
    });

    this.emitModelChangeEvents(filteredPacket.actions, ownClientTxIds);
    await this.emitOutboxCount();
    if (syncCursorAdvanced) {
      this.ctx.emitEvent?.({
        lastSyncId: this.ctx.cursor.lastSyncId,
        type: "syncComplete",
      });
    }
  }

  private async handleEmptyPacket(packet: DeltaPacket): Promise<void> {
    const syncCursorAdvanced = await this.updateSyncMetadata(packet.lastSyncId);
    const outboxManager = this.ctx.getOutboxManager();
    if (outboxManager) {
      await outboxManager.completeUpToSyncId(this.ctx.cursor.lastSyncId);
    }
    await this.emitOutboxCount();
    if (syncCursorAdvanced) {
      this.ctx.emitEvent?.({
        lastSyncId: this.ctx.cursor.lastSyncId,
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

  /**
   * Creates a delta target that writes to storage immediately but collects
   * identity map operations for deferred application in a single batch.
   */
  private createDeferredDeltaTarget(ops: DeferredMapOp[], action: SyncAction) {
    return {
      delete: async (modelName: string, id: string) => {
        await this.ctx.storage.delete(modelName, id);
        ops.push({
          clientTxId: action.clientTxId,
          id,
          modelName,
          type: "delete",
        });
      },
      get: (modelName: string, id: string) =>
        this.ctx.storage.get<Record<string, unknown>>(modelName, id),
      patch: async (
        modelName: string,
        id: string,
        changes: Record<string, unknown>
      ) => {
        const existing = await this.ctx.storage.get<Record<string, unknown>>(
          modelName,
          id
        );
        const pk = this.ctx.registry.getPrimaryKey(modelName);
        const updated = existing
          ? { ...existing, ...changes }
          : { ...changes, [pk]: id };
        await this.ctx.storage.put(modelName, updated);
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
        const pk = this.ctx.registry.getPrimaryKey(modelName);
        const row = { ...data, [pk]: id };
        await this.ctx.storage.put(modelName, row);
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
        this.ctx.registry,
        { mergeUpdates: true }
      );
    }
  }

  private async updateSyncMetadata(lastSyncId: SyncId): Promise<boolean> {
    const advanced = await this.ctx.cursor.advance(lastSyncId);
    if (advanced) {
      // Bound the sync-actions store: actions at or below the bootstrap floor
      // are superseded by the snapshot and never replayed.
      await this.ctx.storage.pruneSyncActions(this.ctx.cursor.firstSyncId);
    }
    return advanced;
  }

  private async finishOutboxProcessing(
    actions: SyncAction[]
  ): Promise<Set<string>> {
    const outboxManager = this.ctx.getOutboxManager();
    const confirmedTxIds =
      (await outboxManager?.confirmFromActions(actions)) ?? new Set<string>();
    if (outboxManager) {
      await outboxManager.completeUpToSyncId(this.ctx.cursor.lastSyncId);
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
      const eventAction = DeltaPipeline.resolveModelChangeAction(action.action);
      if (!eventAction) {
        continue;
      }
      this.ctx.emitEvent?.({
        action: eventAction,
        modelId: action.modelId,
        modelName: action.modelName,
        type: "modelChange",
      });
    }
  }

  private async emitOutboxCount(): Promise<void> {
    if (!this.ctx.emitEvent) {
      return;
    }
    // oxlint-disable-next-line no-await-expression-member
    const pendingCount = (await this.getActiveOutboxTransactions()).length;
    this.ctx.emitEvent({ pendingCount, type: "outboxChange" });
  }

  private async rebasePendingTransactions(
    pending: Transaction[],
    actions: SyncAction[]
  ): Promise<void> {
    if (pending.length === 0) {
      return;
    }

    const rebaseOptions: RebaseOptions = {
      clientId: this.ctx.getClientId(),
      defaultResolution: this.ctx.options.rebaseStrategy ?? "server-wins",
      fieldLevelConflicts: this.ctx.options.fieldLevelConflicts ?? true,
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
      await this.ctx.storage.removeFromOutbox(tx.clientTxId);
      // Defer identity map rollback until the batch so it runs in the same
      // runInAction as the server merge.  Firing it here would delete the
      // item from the identity map and emit modelChange(delete) BEFORE the
      // deferred batch re-adds it, causing a visible flash of empty state.
      this.ctx.setDeferredConflictTxs([
        ...this.ctx.getDeferredConflictTxs(),
        tx,
      ]);
    } else if (effect.kind === "patch-original") {
      tx.original = effect.original;
      await this.ctx.storage.updateOutboxTransaction(tx.clientTxId, {
        original: effect.original,
      });
    }

    this.ctx.emitEvent?.({
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
      await this.ctx.storage.updateOutboxTransaction(patch.clientTxId, {
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
        await this.ctx.storage.setPartialIndex(
          action.modelName,
          indexedKey,
          keyValue
        );
      }
    }
  }
}
