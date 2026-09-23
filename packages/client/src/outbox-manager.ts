import type {
  ArchiveTransactionOptions,
  CancelScheduled,
  MutateResult,
  SyncAction,
  SyncId,
  SyncRuntime,
  Transaction,
  UnarchiveTransactionOptions,
} from "@stratasync/core";
import {
  createArchiveTransaction,
  createDeleteTransaction,
  createInsertTransaction,
  createTransactionBatch,
  createUnarchiveTransaction,
  createUpdateTransaction,
  isSyncIdGreaterThan,
  maxSyncId,
  systemRuntime,
  ZERO_SYNC_ID,
} from "@stratasync/core";

import type { StorageAdapter, TransportAdapter } from "./types.js";

interface InvalidMutationBatchError extends Error {
  code: "INVALID_MUTATION_BATCH";
  clientTxId: string;
  details?: unknown;
}

const isInvalidMutationBatchError = (
  error: unknown
): error is InvalidMutationBatchError =>
  error instanceof Error &&
  "code" in error &&
  error.code === "INVALID_MUTATION_BATCH" &&
  "clientTxId" in error &&
  typeof error.clientTxId === "string";

/**
 * Options for the outbox manager
 */
export interface OutboxManagerOptions {
  /** Storage adapter for persisting transactions */
  storage: StorageAdapter;
  /** Transport adapter for sending transactions */
  transport: TransportAdapter;
  /** Client ID */
  clientId: string;
  /** Batch mutations together */
  batchMutations?: boolean;
  /** Delay before sending batch (ms) */
  batchDelay?: number;
  /** Maximum batch size */
  maxBatchSize?: number;
  /** Callback when transaction state changes */
  onTransactionStateChange?: (tx: Transaction) => void;
  /** Callback when transaction is rejected by server */
  onTransactionRejected?: (tx: Transaction) => void;
  /** Clock, batch timer and transaction id source. Defaults to `systemRuntime`. */
  runtime?: SyncRuntime;
}

/**
 * Returns true for transaction states that are still "in flight" — queued to
 * send, sent and awaiting a server ack, or awaiting the sync cursor to catch
 * up. Completed/failed transactions are excluded.
 */
const isActiveTransaction = (tx: Transaction): boolean =>
  tx.state === "queued" || tx.state === "sent" || tx.state === "awaitingSync";

/**
 * Manages the outbox queue of pending transactions
 */
export class OutboxManager {
  private readonly storage: StorageAdapter;
  private readonly transport: TransportAdapter;
  private readonly clientId: string;
  private readonly batchMutations: boolean;
  private readonly batchDelay: number;
  private readonly maxBatchSize: number;
  private readonly onTransactionStateChange?: (tx: Transaction) => void;
  private readonly onTransactionRejected?: (tx: Transaction) => void;
  private readonly runtime: SyncRuntime;

  private pendingBatch: Transaction[] = [];
  private cancelBatchTimer: CancelScheduled | null = null;
  private processing = false;
  private processingPromise: Promise<void> | null = null;
  // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
  private sendQueue: Promise<void> = Promise.resolve();
  private lifecycleVersion = 0;

  /**
   * clientTxIds an in-memory sender owns: waiting in `pendingBatch`, or
   * dispatched and not yet settled. A drain of the persisted outbox must not
   * resend these (or reset their "sent" state), or the server receives them
   * twice and the second send regresses an acked transaction to "sent".
   */
  private readonly claimedTxIds = new Set<string>();

  /**
   * Claimed clientTxIds discarded (rebase conflict, cross-tab confirmation)
   * while their batch waited on `sendQueue`. The batch closure still holds
   * them, so `sendClaimedBatch` skips them: a transaction reported as dropped
   * must never reach the server afterwards. Cleared on release.
   */
  private readonly discardedClaims = new Set<string>();

  /**
   * Transactions whose send failed at the transport, in queue order, that no
   * later send has carried yet. Every send carries them first, so a later
   * transaction (say `update X`) never reaches the server ahead of an earlier
   * one that hit a transient failure (`create X`), which the server would
   * otherwise reject.
   */
  private retryBacklog: Transaction[] = [];

  /**
   * Tracks clientTxIds created by THIS runtime instance only.
   * Used for echo suppression so cross-tab transactions (which share
   * IndexedDB but not this in-memory set) are not incorrectly skipped.
   */
  private readonly localClientTxIds = new Set<string>();

  /**
   * Strictly increasing sequence stamped on every queued transaction.
   *
   * The outbox replays in `batchIndex` order (see `storage-idb/stores/outbox.ts`).
   * `createdAt` cannot order it: it is millisecond-resolution (transactions
   * created in one tick tie) and wall-clock (it steps backwards on NTP
   * corrections), so `create X` followed by `update X` could replay in the
   * wrong order after a reload.
   */
  private nextBatchIndex = 0;
  /**
   * Seeds `nextBatchIndex` from whatever is already persisted before the first
   * transaction is stamped, so a fresh runtime never re-issues an index below
   * one another tab (or a previous session) already used.
   */
  private batchIndexSeeded: Promise<void> | null = null;

  constructor(options: OutboxManagerOptions) {
    this.storage = options.storage;
    this.transport = options.transport;
    this.clientId = options.clientId;
    this.batchMutations = options.batchMutations ?? true;
    this.batchDelay = options.batchDelay ?? 50;
    this.maxBatchSize = options.maxBatchSize ?? 100;
    this.onTransactionStateChange = options.onTransactionStateChange;
    this.onTransactionRejected = options.onTransactionRejected;
    this.runtime = options.runtime ?? systemRuntime;
  }

  /**
   * Queues an INSERT transaction
   */
  async insert(
    modelName: string,
    modelId: string,
    data: Record<string, unknown>
  ): Promise<Transaction> {
    const tx = createInsertTransaction(
      this.clientId,
      modelName,
      modelId,
      data,
      this.runtime
    );
    await this.queueTransaction(tx);
    return tx;
  }

  /**
   * Queues an UPDATE transaction
   */
  async update(
    modelName: string,
    modelId: string,
    changes: Record<string, unknown>,
    original: Record<string, unknown>
  ): Promise<Transaction> {
    const tx = createUpdateTransaction(
      this.clientId,
      modelName,
      modelId,
      changes,
      original,
      this.runtime
    );
    await this.queueTransaction(tx);
    return tx;
  }

  /**
   * Queues a DELETE transaction
   */
  async delete(
    modelName: string,
    modelId: string,
    original: Record<string, unknown>
  ): Promise<Transaction> {
    const tx = createDeleteTransaction(
      this.clientId,
      modelName,
      modelId,
      original,
      this.runtime
    );
    await this.queueTransaction(tx);
    return tx;
  }

  /**
   * Queues an ARCHIVE transaction
   */
  async archive(
    modelName: string,
    modelId: string,
    options: ArchiveTransactionOptions = {}
  ): Promise<Transaction> {
    const tx = createArchiveTransaction(
      this.clientId,
      modelName,
      modelId,
      options,
      this.runtime
    );
    await this.queueTransaction(tx);
    return tx;
  }

  /**
   * Queues an UNARCHIVE transaction
   */
  async unarchive(
    modelName: string,
    modelId: string,
    options: UnarchiveTransactionOptions = {}
  ): Promise<Transaction> {
    const tx = createUnarchiveTransaction(
      this.clientId,
      modelName,
      modelId,
      options,
      this.runtime
    );
    await this.queueTransaction(tx);
    return tx;
  }

  /**
   * Queues a transaction for sending
   */
  private async queueTransaction(tx: Transaction): Promise<void> {
    await this.ensureBatchIndexSeeded();
    this.localClientTxIds.add(tx.clientTxId);
    tx.batchIndex = this.nextBatchIndex;
    this.nextBatchIndex += 1;
    // Persist to storage first
    await this.storage.addToOutbox(tx);
    this.claimedTxIds.add(tx.clientTxId);
    this.onTransactionStateChange?.(tx);

    if (this.batchMutations) {
      this.pendingBatch.push(tx);
      this.scheduleBatchSend();
    } else {
      await this.dispatchBatch([tx]);
    }
  }

  private ensureBatchIndexSeeded(): Promise<void> {
    if (!this.batchIndexSeeded) {
      this.batchIndexSeeded = (async () => {
        this.seedBatchIndex(await this.storage.getOutbox());
      })();
    }
    return this.batchIndexSeeded;
  }

  /**
   * Keeps the sequence above anything already persisted (by this runtime or
   * another tab) so newly queued transactions never sort before replayed ones.
   */
  private seedBatchIndex(persisted: Transaction[]): void {
    for (const tx of persisted) {
      if (tx.batchIndex !== undefined && tx.batchIndex >= this.nextBatchIndex) {
        this.nextBatchIndex = tx.batchIndex + 1;
      }
    }
  }

  /**
   * Schedules sending the pending batch
   */
  private scheduleBatchSend(): void {
    this.clearBatchTimer();

    // Send immediately if batch is full
    if (this.pendingBatch.length >= this.maxBatchSize) {
      this.flushBatch();
      return;
    }

    this.cancelBatchTimer = this.runtime.schedule(() => {
      this.cancelBatchTimer = null;
      this.flushBatch();
    }, this.batchDelay);
  }

  private clearBatchTimer(): void {
    this.cancelBatchTimer?.();
    this.cancelBatchTimer = null;
  }

  /**
   * Flushes the pending batch
   */
  private flushBatch(): void {
    this.clearBatchTimer();

    if (this.pendingBatch.length === 0) {
      return;
    }

    const batch = this.pendingBatch;
    this.pendingBatch = [];

    // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
    this.dispatchBatch(batch).catch(() => {
      // Errors are handled in sendBatch
    });
  }

  private dispatchBatch(transactions: Transaction[]): Promise<void> {
    this.claim(transactions);
    return this.enqueueSend(async (version) => {
      try {
        await this.sendBatch(transactions, version);
      } finally {
        this.release(transactions, version);
      }
    });
  }

  /** Runs `job` after every send already queued, one job at a time. */
  private enqueueSend(job: (version: number) => Promise<void>): Promise<void> {
    const version = this.lifecycleVersion;
    const previousQueue = this.sendQueue;
    const sendPromise = (async () => {
      await previousQueue;
      await job(version);
    })();
    // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
    this.sendQueue = sendPromise.catch(() => {
      /* noop */
    });
    return sendPromise;
  }

  private claim(transactions: Transaction[]): void {
    for (const tx of transactions) {
      this.claimedTxIds.add(tx.clientTxId);
    }
  }

  private release(transactions: Transaction[], version: number): void {
    if (!this.isLifecycleCurrent(version)) {
      return;
    }
    for (const tx of transactions) {
      this.claimedTxIds.delete(tx.clientTxId);
      this.discardedClaims.delete(tx.clientTxId);
    }
  }

  private withoutDiscarded(transactions: Transaction[]): Transaction[] {
    if (this.discardedClaims.size === 0) {
      return transactions;
    }
    return transactions.filter(
      (tx) => !this.discardedClaims.has(tx.clientTxId)
    );
  }

  /** Prepends the transport-failed transactions still owed to the server. */
  private takeRetryBacklog(transactions: Transaction[]): Transaction[] {
    if (this.retryBacklog.length === 0) {
      return transactions;
    }
    const requested = new Set(transactions.map((tx) => tx.clientTxId));
    const owed = this.retryBacklog.filter(
      (tx) => !requested.has(tx.clientTxId)
    );
    this.retryBacklog = [];
    return [...owed, ...transactions];
  }

  private isLifecycleCurrent(version: number): boolean {
    return version === this.lifecycleVersion;
  }

  waitForInflightSends(): Promise<void> {
    return this.sendQueue;
  }

  /**
   * Sends a batch of transactions
   */
  private async sendBatch(
    requested: Transaction[],
    version: number
  ): Promise<void> {
    if (!this.isLifecycleCurrent(version)) {
      return;
    }
    const transactions = this.takeRetryBacklog(requested);
    if (transactions.length === 0) {
      return;
    }
    const carried = transactions.slice(
      0,
      transactions.length - requested.length
    );
    this.claim(carried);
    try {
      await this.sendClaimedBatch(transactions, version);
    } finally {
      this.release(carried, version);
    }
  }

  private async sendClaimedBatch(
    claimed: Transaction[],
    version: number
  ): Promise<void> {
    const markedSent = await this.markTransactionsSent(
      this.withoutDiscarded(claimed),
      version
    );
    if (!markedSent) {
      return;
    }
    // Checked again with no await before `mutate`: a rebase may have dropped
    // a transaction while it was being marked sent.
    const transactions = this.withoutDiscarded(claimed);
    if (transactions.length === 0) {
      return;
    }

    const batch = createTransactionBatch(transactions, this.runtime);

    try {
      const result = await this.transport.mutate(batch);
      if (!this.isLifecycleCurrent(version)) {
        return;
      }
      await this.handleMutateResult(transactions, result, version);
    } catch (error) {
      if (
        this.isLifecycleCurrent(version) &&
        isInvalidMutationBatchError(error)
      ) {
        await this.handleInvalidMutationBatch(transactions, error, version);
        return;
      }
      await this.handleTransportFailure(transactions, error, version);
      throw error;
    }
  }

  private async markTransactionsSent(
    transactions: Transaction[],
    version: number
  ): Promise<boolean> {
    for (const tx of transactions) {
      if (!this.isLifecycleCurrent(version)) {
        return false;
      }
      tx.state = "sent";
      await this.storage.updateOutboxTransaction(tx.clientTxId, {
        state: "sent",
      });
      if (!this.isLifecycleCurrent(version)) {
        return false;
      }
      this.onTransactionStateChange?.(tx);
    }

    return true;
  }

  private async handleTransportFailure(
    transactions: Transaction[],
    error: unknown,
    version: number
  ): Promise<void> {
    if (!this.isLifecycleCurrent(version)) {
      throw error;
    }

    // Transport failures remain queued so reconnect/restart can replay them.
    for (const tx of transactions) {
      const retryCount = tx.retryCount + 1;
      tx.state = "queued";
      tx.lastError = error instanceof Error ? error.message : "Unknown error";
      tx.retryCount = retryCount;
      await this.storage.updateOutboxTransaction(tx.clientTxId, {
        lastError: tx.lastError,
        retryCount,
        state: "queued",
      });
      if (!this.isLifecycleCurrent(version)) {
        throw error;
      }
      this.onTransactionStateChange?.(tx);
    }
    this.retryBacklog.push(...this.withoutDiscarded(transactions));
  }

  private async handleInvalidMutationBatch(
    transactions: Transaction[],
    error: InvalidMutationBatchError,
    version: number
  ): Promise<void> {
    const rejectedTx = transactions.find(
      (tx) => tx.clientTxId === error.clientTxId
    );
    if (!rejectedTx) {
      await this.handleTransportFailure(transactions, error, version);
      throw error;
    }

    const remainingTransactions = transactions.filter(
      (tx) => tx.clientTxId !== error.clientTxId
    );

    await this.adoptPersistedOriginal(rejectedTx);
    rejectedTx.state = "failed";
    rejectedTx.lastError = error.message;
    await this.storage.updateOutboxTransaction(rejectedTx.clientTxId, {
      lastError: rejectedTx.lastError,
      state: "failed",
    });
    if (!this.isLifecycleCurrent(version)) {
      return;
    }
    this.onTransactionRejected?.(rejectedTx);
    await this.removeRejectedTransaction(rejectedTx);
    if (!this.isLifecycleCurrent(version)) {
      return;
    }
    this.onTransactionStateChange?.(rejectedTx);

    for (const tx of remainingTransactions) {
      tx.state = "queued";
      tx.lastError = undefined;
      await this.storage.updateOutboxTransaction(tx.clientTxId, {
        lastError: undefined,
        state: "queued",
      });
      if (!this.isLifecycleCurrent(version)) {
        return;
      }
      this.onTransactionStateChange?.(tx);
    }

    if (remainingTransactions.length > 0) {
      await this.sendBatch(remainingTransactions, version);
    }
  }

  /**
   * Rebase persists each pending transaction's rebased `original` through
   * `storage.updateOutboxTransaction`, onto the row it read from storage. A
   * storage that returns copies (IndexedDB) leaves the object held by the send
   * batch with the pre-rebase snapshot, so a rejection must roll back to the
   * persisted one, or it restores a value the server has since overwritten.
   */
  private async adoptPersistedOriginal(tx: Transaction): Promise<void> {
    const outbox = await this.storage.getOutbox();
    const persisted = outbox.find(
      (entry) => entry.clientTxId === tx.clientTxId
    );
    if (persisted?.original !== undefined) {
      tx.original = persisted.original;
    }
  }

  private removeRejectedTransaction(tx: Transaction): Promise<void> {
    return this.discardTransaction(tx.clientTxId);
  }

  /**
   * Drops a transaction from the outbox without completing it (the server
   * rejected it, or a rebase conflict resolved against it). Also forgets the
   * id in the in-memory echo-suppression set so that set stays bounded.
   */
  async discardTransaction(clientTxId: string): Promise<void> {
    const batched = this.pendingBatch.length;
    this.pendingBatch = this.pendingBatch.filter(
      (tx) => tx.clientTxId !== clientTxId
    );
    if (this.pendingBatch.length !== batched) {
      this.claimedTxIds.delete(clientTxId);
    } else if (this.claimedTxIds.has(clientTxId)) {
      this.discardedClaims.add(clientTxId);
    }
    await this.storage.removeFromOutbox(clientTxId);
    this.localClientTxIds.delete(clientTxId);
    this.retryBacklog = this.retryBacklog.filter(
      (tx) => tx.clientTxId !== clientTxId
    );
  }

  /**
   * Handles the result of a mutation batch
   */
  private async handleMutateResult(
    transactions: Transaction[],
    result: MutateResult,
    version: number
  ): Promise<void> {
    const txMap = new Map(transactions.map((tx) => [tx.clientTxId, tx]));
    let highestSyncId: SyncId = result.lastSyncId ?? ZERO_SYNC_ID;
    for (const txResult of result.results) {
      if (txResult.syncId !== undefined) {
        highestSyncId = maxSyncId(highestSyncId, txResult.syncId);
      }
    }

    const unresolved = new Map(txMap);
    for (const txResult of result.results) {
      if (!this.isLifecycleCurrent(version)) {
        return;
      }
      const tx = txMap.get(txResult.clientTxId);
      if (!tx) {
        continue;
      }
      unresolved.delete(tx.clientTxId);

      if (txResult.success) {
        const syncIdNeededForCompletion =
          txResult.syncId ??
          (highestSyncId === ZERO_SYNC_ID ? undefined : highestSyncId);
        if (syncIdNeededForCompletion === undefined) {
          // No sync id means there is no cursor to wait for. Completing now
          // avoids parking the transaction in awaitingSync forever.
          await this.completeTransactionNow(tx);
        } else {
          tx.state = "awaitingSync";
          tx.syncIdNeededForCompletion = syncIdNeededForCompletion;
          tx.lastError = undefined;
          await this.storage.updateOutboxTransaction(tx.clientTxId, {
            lastError: undefined,
            state: "awaitingSync",
            syncIdNeededForCompletion,
          });
        }
      } else {
        await this.adoptPersistedOriginal(tx);
        tx.state = "failed";
        tx.lastError = txResult.error ?? "Unknown error";
        tx.retryCount += 1;
        await this.storage.updateOutboxTransaction(tx.clientTxId, {
          lastError: tx.lastError,
          retryCount: tx.retryCount,
          state: "failed",
        });
        this.onTransactionRejected?.(tx);
        await this.removeRejectedTransaction(tx);
      }

      if (!this.isLifecycleCurrent(version)) {
        return;
      }
      this.onTransactionStateChange?.(tx);
    }

    // A transaction the server did not report on would otherwise sit in
    // "sent" until the next reconnect. Requeue it so the next drain retries.
    if (unresolved.size > 0) {
      await this.handleTransportFailure(
        [...unresolved.values()],
        new Error("Mutation result did not include the transaction"),
        version
      );
    }
  }

  /**
   * Processes any pending transactions from storage (e.g., after reconnect)
   */
  async processPendingTransactions(): Promise<void> {
    if (this.processing) {
      await this.processingPromise;
      return;
    }

    this.processing = true;
    this.processingPromise = this.doProcessPending();

    try {
      await this.processingPromise;
    } finally {
      this.processing = false;
      this.processingPromise = null;
    }
  }

  private async doProcessPending(): Promise<void> {
    await this.flushPendingBatchNow();
    // Replay as one job on the send queue, so no other send interleaves
    // between reading the outbox and sending what it holds.
    await this.enqueueSend((version) => this.replayPersisted(version));
  }

  private async replayPersisted(version: number): Promise<void> {
    const pending = await this.storage.getOutbox();
    if (!this.isLifecycleCurrent(version)) {
      return;
    }
    this.seedBatchIndex(pending);
    // Anything owed from a transport failure is persisted as queued and is
    // replayed below in outbox order.
    this.retryBacklog = [];

    // Reset unconfirmed transport states back to queued so they can retry.
    // Claimed transactions belong to a send queued behind this replay.
    const unclaimed = pending.filter(
      (tx) => !this.claimedTxIds.has(tx.clientTxId)
    );
    for (const tx of unclaimed) {
      if (tx.state === "sent") {
        tx.state = "queued";
        await this.storage.updateOutboxTransaction(tx.clientTxId, {
          state: "queued",
        });
        this.onTransactionStateChange?.(tx);
      }
    }

    // Filter to only queued transactions
    const queued = unclaimed.filter((tx) => tx.state === "queued");

    // Send in batches
    for (let i = 0; i < queued.length; i += this.maxBatchSize) {
      const batch = queued.slice(i, i + this.maxBatchSize);
      this.claim(batch);
      try {
        await this.sendBatch(batch, version);
      } finally {
        this.release(batch, version);
      }
    }
  }

  private async flushPendingBatchNow(): Promise<void> {
    this.clearBatchTimer();

    if (this.pendingBatch.length === 0) {
      return;
    }

    const batch = this.pendingBatch;
    this.pendingBatch = [];
    await this.dispatchBatch(batch);
  }

  /**
   * Returns the outbox transactions that are still in flight.
   */
  async getActiveTransactions(): Promise<Transaction[]> {
    const outbox = await this.storage.getOutbox();
    return outbox.filter(isActiveTransaction);
  }

  /**
   * Gets the count of pending transactions
   */
  async getPendingCount(): Promise<number> {
    const outbox = await this.storage.getOutbox();
    return outbox.filter(isActiveTransaction).length;
  }

  /**
   * Returns the set of clientTxIds created by this runtime instance.
   */
  getLocalClientTxIds(): ReadonlySet<string> {
    return this.localClientTxIds;
  }

  /**
   * Confirms transactions against a batch of server actions, removing them
   * from the outbox and from the in-memory localClientTxIds set.
   *
   * Absorbs two previously-orchestrator-owned passes:
   *  1. Direct confirmation: any outbox transaction whose clientTxId appears
   *     in the actions is removed.
   *  2. Redundant create removal: when a model's create (I) is observed, any
   *     outbox create for that model is removed — covering both the matching
   *     clientTxId and legacy (clientTxId-less) creates for the same model.
   *
   * Returns the union of removed clientTxIds.
   */
  async confirmFromActions(actions: SyncAction[]): Promise<Set<string>> {
    const confirmed = new Set<string>();
    const confirmedClientTxIds = OutboxManager.collectClientTxIds(actions);
    const createsByModelId = OutboxManager.collectCreatesByModelId(actions);

    if (confirmedClientTxIds.size === 0 && createsByModelId.size === 0) {
      return confirmed;
    }

    const outbox = await this.storage.getOutbox();
    for (const tx of outbox) {
      if (confirmedClientTxIds.has(tx.clientTxId)) {
        await this.removeConfirmedTransaction(tx.clientTxId, confirmed);
        continue;
      }

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
      await this.removeConfirmedTransaction(tx.clientTxId, confirmed);
    }

    return confirmed;
  }

  private async removeConfirmedTransaction(
    clientTxId: string,
    confirmed: Set<string>
  ): Promise<void> {
    // Confirmed ids must also leave the in-memory set so it stays bounded.
    await this.discardTransaction(clientTxId);
    confirmed.add(clientTxId);
  }

  private static collectClientTxIds(actions: SyncAction[]): Set<string> {
    const ids = new Set<string>();
    for (const action of actions) {
      if (typeof action.clientTxId === "string") {
        ids.add(action.clientTxId);
      }
    }
    return ids;
  }

  private static collectCreatesByModelId(
    actions: SyncAction[]
  ): Map<string, { clientTxIds: Set<string>; hasLegacyCreate: boolean }> {
    const createsByModelId = new Map<
      string,
      { clientTxIds: Set<string>; hasLegacyCreate: boolean }
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

    return createsByModelId;
  }

  /**
   * Removes a transaction from the outbox and marks it completed. Shared by
   * the mutate-result path (when no sync id is owed) and completeUpToSyncId.
   */
  private async completeTransactionNow(tx: Transaction): Promise<void> {
    await this.discardTransaction(tx.clientTxId);
    tx.state = "completed";
  }

  /**
   * Completes any awaiting transactions up to the given sync ID
   */
  async completeUpToSyncId(lastSyncId: SyncId): Promise<number> {
    const outbox = await this.storage.getOutbox();
    let completed = 0;

    for (const tx of outbox) {
      if (
        tx.state === "awaitingSync" &&
        typeof tx.syncIdNeededForCompletion === "string" &&
        !isSyncIdGreaterThan(tx.syncIdNeededForCompletion, lastSyncId)
      ) {
        await this.completeTransactionNow(tx);
        completed += 1;
      }
    }

    return completed;
  }

  /**
   * Forces an immediate flush of pending batches
   */
  async flush(): Promise<void> {
    await this.flushPendingBatchNow();
    await this.processingPromise;
    await this.waitForInflightSends();
  }

  dispose(): void {
    this.lifecycleVersion += 1;
    this.clearBatchTimer();
    this.pendingBatch = [];
    this.localClientTxIds.clear();
    this.claimedTxIds.clear();
    this.discardedClaims.clear();
    this.retryBacklog = [];
    // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
    this.sendQueue = Promise.resolve();
  }

  /**
   * Clears all pending transactions
   */
  async clear(): Promise<void> {
    this.dispose();

    const outbox = await this.storage.getOutbox();
    for (const tx of outbox) {
      await this.storage.removeFromOutbox(tx.clientTxId);
    }
  }
}
