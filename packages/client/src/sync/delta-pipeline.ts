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

import type { BatchOperation } from "../types.js";
import { getModelKey } from "../utils.js";
import type { SyncContext } from "./context.js";
import {
  applyPendingTransactionsToIdentityMaps,
  excludePrivacyWithheldTransactions,
  touchPendingTransactionTargets,
} from "./pending-hydration.js";

interface DeferredMapOp {
  type: "merge" | "delete";
  modelName: string;
  id: string;
  data?: Record<string, unknown>;
  clientTxId?: string;
}

/**
 * In-memory resolution of a delta packet, collapsed per `modelName:modelId`.
 *
 * `rows` doubles as a read-through cache (a `null` entry is a cached miss);
 * `deleted` tracks keys removed within the packet; `writes` is the collapsed
 * set of storage operations to flush, one per key.
 */
interface DeltaStaging {
  rows: Map<string, Record<string, unknown> | null>;
  deleted: Set<string>;
  writes: Map<string, BatchOperation>;
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
 * Upper bound on actions buffered across catch-up pages before flushing.
 * Sized well above the server's 1000-action page so a typical backlog lands in
 * one flush, while a badly stale client still can't buffer unboundedly.
 */
const COALESCED_CATCH_UP_ACTION_LIMIT = 10_000;

/** Delay before resubscribing after the live delta stream fails. */
const RESUBSCRIBE_DELAY_MS = 5000;

/**
 * Delay before retrying a group-change re-bootstrap that failed. The latch is
 * still set, so packets keep being held until an attempt succeeds.
 */
const GROUP_CHANGE_RETRY_DELAY_MS = 5000;

/**
 * A membership change: a group was shared with this user (its history sits
 * before the cursor, so the delta stream will never carry it) or taken away
 * (its rows would otherwise stay cached, silently frozen). Only a full
 * bootstrap, which the server filters on current membership, converges both.
 */
const isGroupChangeAction = (action: SyncAction): boolean =>
  action.action === "G" || action.action === "S";

const getAuthoritativeGroups = (
  actions: SyncAction[]
): string[] | undefined => {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index];
    if (!action || !isGroupChangeAction(action)) {
      continue;
    }
    const groups = action.data.subscribedSyncGroups;
    if (
      Array.isArray(groups) &&
      groups.every((group): group is string => typeof group === "string")
    ) {
      return [...new Set(groups)];
    }
  }
  return undefined;
};

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
  applyPendingOutboxTransactions(
    authoritativeReplacement?: boolean
  ): Promise<void>;
  /** Completes + processes pending outbox transactions, emits the count. */
  processOutboxTransactions(): Promise<void>;
  /**
   * Loads the rows behind a newly granted partial-index coverage key and
   * records the coverage. Absent until the lazy loader is wired.
   */
  loadCoverage?(
    modelName: string,
    indexedKey: string,
    keyValue: string
  ): Promise<void>;
}

/** A partial-index coverage key granted by a `"C"` action. */
interface CoverageKey {
  modelName: string;
  indexedKey: string;
  keyValue: string;
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
  /** Coverage keys awaiting a fetch once the state lock is released. */
  private pendingCoverageLoads: CoverageKey[] = [];
  /** Pending resubscribe after a stream failure; cleared on reset. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guards against stacking group-change re-bootstraps. */
  private groupChangeBootstrapInFlight = false;
  /** Retry of a failed group-change re-bootstrap; cleared on reset. */
  private groupChangeRetryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: SyncContext, deps: DeltaPipelineDeps) {
    this.ctx = ctx;
    this.deps = deps;
  }

  /**
   * Drops per-run state: a scheduled resubscribe (which would otherwise fire
   * into a later run and open a second, leaked subscription) and coverage
   * keys collected for a packet that no longer belongs to the active run.
   */
  reset(): void {
    this.clearReconnectTimer();
    this.clearGroupChangeRetryTimer();
    this.groupChangeBootstrapInFlight = false;
    this.pendingCoverageLoads = [];
  }

  private clearGroupChangeRetryTimer(): void {
    if (this.groupChangeRetryTimer) {
      clearTimeout(this.groupChangeRetryTimer);
      this.groupChangeRetryTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleResubscribe(runToken: number): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.ctx.isRunActive(runToken) && !this.ctx.getDeltaSubscription()) {
        this.startDeltaSubscription();
      }
    }, RESUBSCRIBE_DELAY_MS);
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

    // Process deltas in background. The loop handles its own stream errors;
    // anything escaping here came from the error path itself, so surface it.
    this.processDeltaStream().catch((error: unknown) => {
      if (this.ctx.isRunning()) {
        this.ctx.recordError(error);
      }
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

  /**
   * Processes the delta stream.
   */
  private async processDeltaStream(): Promise<void> {
    const subscription = this.ctx.getDeltaSubscription();
    if (!subscription) {
      return;
    }
    const runToken = this.ctx.getRunToken();

    try {
      while (this.ctx.isRunActive(runToken)) {
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
      if (this.ctx.isRunActive(runToken)) {
        if (await this.handleBootstrapRequired(error, subscription)) {
          return;
        }
        this.ctx.recordError(error);
        this.scheduleResubscribe(runToken);
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
      await this.bootstrapAndResume();
    } catch (recoveryError) {
      this.ctx.recordError(recoveryError);
    }
    return true;
  }

  /**
   * Runs a full bootstrap under the state lock, re-applies the outbox, then
   * resumes the live stream from the new cursor. Shared by cursor-too-old
   * recovery and by group-change reconciliation.
   */
  private async bootstrapAndResume(): Promise<void> {
    await this.ctx.runWithStateLock(async () => {
      const activeRunToken = this.ctx.getRunToken();
      const privacyReconcile = this.ctx.isGroupChangePending();
      await this.deps.runBootstrap(activeRunToken);
      if (!this.ctx.isRunActive(activeRunToken)) {
        return;
      }
      await this.deps.applyPendingOutboxTransactions(privacyReconcile);
    });

    if (!this.ctx.isRunActive(this.ctx.getRunToken())) {
      return;
    }

    await this.deps.processOutboxTransactions();
    if (this.ctx.isRunning() && !this.ctx.getDeltaSubscription()) {
      this.startDeltaSubscription(this.ctx.cursor.lastSyncId);
    }
    if (this.ctx.isRunning()) {
      this.ctx.setState("syncing");
    }
  }

  /**
   * Latches the group-change reconcile and schedules the full re-bootstrap it
   * requires.
   *
   * Called from inside packet application, which holds the state lock, so the
   * bootstrap itself runs on a detached task: it takes that lock again. The
   * latch is persisted first, so a stop() before the task lands still leaves
   * the next start owing the bootstrap, and it is only cleared by a bootstrap
   * that completes (see BootstrapRunner.bootstrap).
   */
  private async requestGroupChangeBootstrap(
    authoritativeGroups?: string[]
  ): Promise<void> {
    const wasPending = this.ctx.isGroupChangePending();
    if (authoritativeGroups) {
      this.ctx.setGroups(authoritativeGroups);
    }
    if (!wasPending) {
      this.ctx.setGroupChangePending(true);
    }
    const pendingMeta = wasPending ? {} : { groupChangePending: true };
    await this.ctx.storage.setMeta({
      ...(authoritativeGroups
        ? { subscribedSyncGroups: authoritativeGroups }
        : {}),
      ...pendingMeta,
      updatedAt: Date.now(),
    });
    if (!wasPending) {
      // The current identity maps were built under authority the server just
      // invalidated. Quarantine them immediately while keeping persisted rows
      // intact until the replacement snapshot commits atomically. The durable
      // latch prevents those rows from being hydrated after a restart.
      this.ctx.identityMaps.batch(() => {
        this.ctx.identityMaps.clearAll();
      });
    }
    this.scheduleGroupChangeBootstrap(this.ctx.getRunToken());
  }

  private scheduleGroupChangeBootstrap(runToken: number): void {
    if (this.groupChangeBootstrapInFlight || !this.ctx.isRunActive(runToken)) {
      return;
    }
    this.groupChangeBootstrapInFlight = true;

    this.runGroupChangeBootstrap(runToken)
      .catch((error: unknown) => {
        if (this.ctx.isRunActive(runToken)) {
          this.ctx.recordError(error);
        }
      })
      .finally(() => {
        this.groupChangeBootstrapInFlight = false;
        // A failed attempt leaves the latch set; keep trying while this run
        // is alive, because every packet is being held until it lands.
        if (this.ctx.isRunActive(runToken) && this.ctx.isGroupChangePending()) {
          this.clearGroupChangeRetryTimer();
          this.groupChangeRetryTimer = setTimeout(() => {
            this.groupChangeRetryTimer = null;
            this.scheduleGroupChangeBootstrap(runToken);
          }, GROUP_CHANGE_RETRY_DELAY_MS);
        }
      });
  }

  private async runGroupChangeBootstrap(runToken: number): Promise<void> {
    // Close the live stream first. The old iterator would otherwise keep
    // consuming (and holding) packets against a cursor the bootstrap is about
    // to replace, and the resume below opens a fresh one from the new cursor.
    const current = this.ctx.getDeltaSubscription();
    this.ctx.setDeltaSubscription(null);
    if (current) {
      try {
        await current.return?.();
      } catch {
        // Best-effort close; the bootstrap proceeds regardless.
      }
    }
    if (!this.ctx.isRunActive(runToken)) {
      return;
    }
    await this.bootstrapAndResume();
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

  /**
   * Fetches deltas page by page and applies them.
   *
   * Pages are buffered and applied as one merged packet so a multi-page
   * backlog lands in a single identity-map batch — one render — instead of
   * stepping the UI visibly through each page. The buffer is capped so a very
   * stale client stays memory-bounded; it flushes on the cap, on the last
   * page, and whenever paging stops.
   */
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
    let buffered: SyncAction[] = [];
    let bufferedLastSyncId: SyncId | null = null;

    const flush = async (): Promise<void> => {
      if (bufferedLastSyncId === null) {
        return;
      }
      const merged: DeltaPacket = {
        actions: buffered,
        lastSyncId: bufferedLastSyncId,
      };
      buffered = [];
      bufferedLastSyncId = null;
      await this.enqueueDeltaPacket(merged);
    };

    try {
      while (true) {
        const packet = await this.fetchDeltaPage(nextAfterSyncId, options);
        if (!packet) {
          await flush();
          return;
        }

        if (
          options.runToken !== undefined &&
          !this.ctx.isRunActive(options.runToken)
        ) {
          // Drop the buffer: the cursor never advanced, so the next run
          // re-fetches these deltas from the same point.
          return;
        }

        if (packet.hasMore && !releaseBarrier) {
          releaseBarrier = this.ctx.deltaReplayGate().hold();
          this.ctx.setCatchingUp(true);
        }

        buffered.push(...packet.actions);
        bufferedLastSyncId = packet.lastSyncId;

        if (
          !packet.hasMore ||
          !isSyncIdGreaterThan(packet.lastSyncId, nextAfterSyncId)
        ) {
          await flush();
          return;
        }

        if (buffered.length >= COALESCED_CATCH_UP_ACTION_LIMIT) {
          await flush();
        }

        nextAfterSyncId = packet.lastSyncId;
      }
    } finally {
      if (releaseBarrier) {
        releaseBarrier();
        this.ctx.setCatchingUp(false);
      }
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

    return null;
  }

  private enqueueDeltaPacket(packet: DeltaPacket): Promise<void> {
    // packetQueue serializes packets against each other; the nested state-lock
    // run keeps packet application serialized against mutations too.
    return this.ctx.packetQueue().run(async () => {
      if (!this.ctx.isRunning()) {
        return;
      }
      await this.ctx.runWithStateLock(() => this.applyDeltaPacket(packet));
      // Outside the state lock: coverage fetches take it themselves, and it
      // is not reentrant.
      await this.drainPendingCoverageLoads();
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
    // Group actions are invalidations rather than ordinary model deltas. A
    // server may redeliver one after the general cursor has moved (for example,
    // when live delivery was missed but a later authorized action arrived), so
    // inspect the received packet before filtering stale model actions. The
    // payload is the server's full current authorized group list and must be
    // adopted before the replacement bootstrap is requested.
    if (packet.actions.some(isGroupChangeAction)) {
      await this.requestGroupChangeBootstrap(
        getAuthoritativeGroups(packet.actions)
      );
      return;
    }

    // Nothing is applied while a group-change re-bootstrap is owed, so the
    // cursor cannot move past the group action. If it did, and the bootstrap
    // then failed, an ordinary reconnect would resume from a cursor beyond
    // the action and it would never be redelivered: the membership change
    // would be lost, which is exactly what the durable action exists to
    // prevent. The cost is a little redelivery once the bootstrap lands.
    if (this.ctx.isGroupChangePending()) {
      this.scheduleGroupChangeBootstrap(this.ctx.getRunToken());
      return;
    }

    const latestAppliedSyncId = this.ctx.cursor.lastSyncId;
    const nextActions = packet.actions.filter((action) =>
      isSyncIdGreaterThan(action.id, latestAppliedSyncId)
    );
    const filteredPacket: DeltaPacket = {
      ...packet,
      actions: nextActions,
    };

    // Checked before anything is applied: a re-bootstrap replaces local state
    // wholesale, so persisting this packet first would be wasted work against
    // a cursor about to be discarded.
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
    const privacyMeta = await this.ctx.storage.getMeta();
    const { privacyWithheldClientTxIds } = privacyMeta;
    const replayPending = !this.ctx.isGroupChangePending();

    this.ctx.identityMaps.batch(() => {
      const replayablePending = replayPending
        ? excludePrivacyWithheldTransactions(
            pending,
            privacyWithheldClientTxIds,
            this.ctx.identityMaps
          )
        : [];
      touchPendingTransactionTargets(this.ctx.identityMaps, replayablePending);

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
      applyPendingTransactionsToIdentityMaps(
        this.ctx.identityMaps,
        replayablePending
      );
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
   * Creates a delta target backed by an in-memory staging area rather than by
   * storage directly.
   *
   * Writing straight through would cost two IndexedDB transactions per action
   * (a `get` then a `put`, each opening its own transaction), so a 1000-action
   * catch-up page meant ~2000 serialized round trips. Staging lets the whole
   * packet resolve in memory and land as a single `writeBatch`.
   */
  private createStagingDeltaTarget(
    staging: DeltaStaging,
    ops: DeferredMapOp[],
    action: SyncAction
  ) {
    const read = async (
      modelName: string,
      id: string
    ): Promise<Record<string, unknown> | null> => {
      const key = getModelKey(modelName, id);
      if (staging.rows.has(key)) {
        return staging.rows.get(key) ?? null;
      }
      if (staging.deleted.has(key)) {
        return null;
      }
      const existing = await this.ctx.storage.get<Record<string, unknown>>(
        modelName,
        id
      );
      // Cache the miss too, so repeated actions on the same row in one packet
      // never re-hit storage.
      staging.rows.set(key, existing);
      return existing;
    };

    const stage = (
      modelName: string,
      id: string,
      row: Record<string, unknown>
    ): void => {
      const key = getModelKey(modelName, id);
      staging.rows.set(key, row);
      staging.deleted.delete(key);
      staging.writes.set(key, { data: row, modelName, type: "put" });
      ops.push({
        clientTxId: action.clientTxId,
        data: row,
        id,
        modelName,
        type: "merge",
      });
    };

    return {
      delete: (modelName: string, id: string) => {
        const key = getModelKey(modelName, id);
        staging.rows.delete(key);
        staging.deleted.add(key);
        staging.writes.set(key, { id, modelName, type: "delete" });
        ops.push({
          clientTxId: action.clientTxId,
          id,
          modelName,
          type: "delete",
        });
        return Promise.resolve();
      },
      get: read,
      patch: async (
        modelName: string,
        id: string,
        changes: Record<string, unknown>
      ) => {
        const existing = await read(modelName, id);
        const pk = this.ctx.registry.getPrimaryKey(modelName);
        stage(
          modelName,
          id,
          existing ? { ...existing, ...changes } : { ...changes, [pk]: id }
        );
      },
      put: (modelName: string, id: string, data: Record<string, unknown>) => {
        const pk = this.ctx.registry.getPrimaryKey(modelName);
        stage(modelName, id, { ...data, [pk]: id });
        return Promise.resolve();
      },
    };
  }

  /**
   * Resolves every action in the packet against an in-memory staging area and
   * persists the collapsed result in one batch. `ops` still carries one entry
   * per action so identity-map echo suppression and ordering are unchanged.
   */
  private async collectDeferredDeltaOps(
    actions: SyncAction[],
    ops: DeferredMapOp[]
  ): Promise<void> {
    const staging: DeltaStaging = {
      deleted: new Set(),
      rows: new Map(),
      writes: new Map(),
    };

    for (const action of actions) {
      const target = this.createStagingDeltaTarget(staging, ops, action);
      await applyDeltas(
        { actions: [action], lastSyncId: action.id },
        target,
        this.ctx.registry,
        { mergeUpdates: true }
      );
    }

    if (staging.writes.size > 0) {
      await this.ctx.storage.writeBatch([...staging.writes.values()]);
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
      await this.discardPendingTransaction(tx.clientTxId);
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

  /**
   * Removes a pending transaction the server side-lined. Goes through the
   * outbox manager when one is attached so its in-memory echo-suppression set
   * forgets the id too; otherwise straight to storage.
   */
  private discardPendingTransaction(clientTxId: string): Promise<void> {
    const outboxManager = this.ctx.getOutboxManager();
    if (outboxManager) {
      return outboxManager.discardTransaction(clientTxId);
    }
    return this.ctx.storage.removeFromOutbox(clientTxId);
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

  /**
   * Processes `"C"` (covering) actions, which grant the client coverage of a
   * partial index key.
   *
   * For a `partial` model the rows behind the key are not in the delta stream,
   * so recording coverage without fetching them would leave `loadByIndex`
   * reporting complete coverage over a set it never loaded — and never
   * self-healing. Those keys are deferred to `pendingCoverageLoads` and fetched
   * after the packet is applied: the fetch re-enters the state lock, which is
   * held for the duration of packet application and is not reentrant.
   *
   * Non-partial models have no lazy fetch, so their coverage is recorded here.
   */
  private async handleCoverageActions(actions: SyncAction[]): Promise<void> {
    for (const action of actions) {
      if (action.action !== "C") {
        continue;
      }
      const { indexedKey, keyValue } = action.data as Record<string, unknown>;
      if (typeof indexedKey !== "string" || typeof keyValue !== "string") {
        continue;
      }

      const isPartial =
        this.ctx.registry.getModelMetadata(action.modelName)?.loadStrategy ===
        "partial";

      if (isPartial && this.deps.loadCoverage) {
        this.pendingCoverageLoads.push({
          indexedKey,
          keyValue,
          modelName: action.modelName,
        });
        continue;
      }

      await this.ctx.storage.setPartialIndex(
        action.modelName,
        indexedKey,
        keyValue
      );
    }
  }

  /**
   * Fetches the rows for coverage keys collected during packet application.
   * Runs outside the state lock; failures are recorded but never abort the
   * packet, which has already been applied.
   */
  private async drainPendingCoverageLoads(): Promise<void> {
    if (this.pendingCoverageLoads.length === 0) {
      return;
    }
    const keys = this.pendingCoverageLoads.splice(0);
    const { loadCoverage } = this.deps;
    if (!loadCoverage) {
      return;
    }

    for (const key of keys) {
      try {
        await loadCoverage(key.modelName, key.indexedKey, key.keyValue);
      } catch (error) {
        if (this.ctx.isRunning()) {
          this.ctx.recordError(error);
        }
      }
    }
  }
}
