import type {
  ArchiveTransactionOptions,
  MutateResult,
  SyncId,
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
  ZERO_SYNC_ID,
} from "@stratasync/core";

import type { StorageAdapter, TransportAdapter } from "./types.js";

const MAX_RETRY_COUNT = 5;

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
}

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

  private pendingBatch: Transaction[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private processing = false;
  private processingPromise: Promise<void> | null = null;
  // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
  private sendQueue: Promise<void> = Promise.resolve();
  private lifecycleVersion = 0;

  /**
   * Tracks clientTxIds created by THIS runtime instance only.
   * Used for echo suppression so cross-tab transactions (which share
   * IndexedDB but not this in-memory set) are not incorrectly skipped.
   */
  private readonly localClientTxIds = new Set<string>();

  constructor(options: OutboxManagerOptions) {
    this.storage = options.storage;
    this.transport = options.transport;
    this.clientId = options.clientId;
    this.batchMutations = options.batchMutations ?? true;
    this.batchDelay = options.batchDelay ?? 50;
    this.maxBatchSize = options.maxBatchSize ?? 100;
    this.onTransactionStateChange = options.onTransactionStateChange;
    this.onTransactionRejected = options.onTransactionRejected;
  }

  /**
   * Queues an INSERT transaction
   */
  async insert(
    modelName: string,
    modelId: string,
    data: Record<string, unknown>
  ): Promise<Transaction> {
    const tx = createInsertTransaction(this.clientId, modelName, modelId, data);
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
      original
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
      original
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
      options
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
      options
    );
    await this.queueTransaction(tx);
    return tx;
  }

  /**
   * Queues a transaction for sending
   */
  private async queueTransaction(tx: Transaction): Promise<void> {
    this.localClientTxIds.add(tx.clientTxId);
    // Persist to storage first
    await this.storage.addToOutbox(tx);
    this.onTransactionStateChange?.(tx);

    if (this.batchMutations) {
      this.pendingBatch.push(tx);
      this.scheduleBatchSend();
    } else {
      await this.dispatchBatch([tx]);
    }
  }

  /**
   * Schedules sending the pending batch
   */
  private scheduleBatchSend(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }

    // Send immediately if batch is full
    if (this.pendingBatch.length >= this.maxBatchSize) {
      this.flushBatch();
      return;
    }

    this.batchTimer = setTimeout(() => {
      this.flushBatch();
    }, this.batchDelay);
  }

  /**
   * Flushes the pending batch
   */
  private flushBatch(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

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
    const version = this.lifecycleVersion;
    const previousQueue = this.sendQueue;
    const sendPromise = (async () => {
      await previousQueue;
      await this.sendBatch(transactions, version);
    })();
    // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
    this.sendQueue = sendPromise.catch(() => {
      /* noop */
    });
    return sendPromise;
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
    transactions: Transaction[],
    version: number
  ): Promise<void> {
    if (transactions.length === 0) {
      return;
    }

    const markedSent = await this.markTransactionsSent(transactions, version);
    if (!markedSent) {
      return;
    }

    const batch = createTransactionBatch(transactions);

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

    // Transport errors are retryable until the retry cap is reached.
    for (const tx of transactions) {
      const retryCount = tx.retryCount + 1;
      const nextState =
        retryCount < MAX_RETRY_COUNT ? "queued" : ("failed" as const);
      tx.state = nextState;
      tx.lastError = error instanceof Error ? error.message : "Unknown error";
      tx.retryCount = retryCount;
      await this.storage.updateOutboxTransaction(tx.clientTxId, {
        lastError: tx.lastError,
        retryCount,
        state: nextState,
      });
      if (!this.isLifecycleCurrent(version)) {
        throw error;
      }
      this.onTransactionStateChange?.(tx);
    }
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

  private async removeRejectedTransaction(tx: Transaction): Promise<void> {
    await this.storage.removeFromOutbox(tx.clientTxId);
    this.localClientTxIds.delete(tx.clientTxId);
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

    for (const txResult of result.results) {
      if (!this.isLifecycleCurrent(version)) {
        return;
      }
      const tx = txMap.get(txResult.clientTxId);
      if (!tx) {
        continue;
      }

      if (txResult.success) {
        const syncIdNeededForCompletion =
          txResult.syncId ??
          (highestSyncId === ZERO_SYNC_ID ? undefined : highestSyncId);
        tx.state = "awaitingSync";
        tx.syncIdNeededForCompletion = syncIdNeededForCompletion;
        tx.lastError = undefined;
        await this.storage.updateOutboxTransaction(tx.clientTxId, {
          lastError: undefined,
          state: "awaitingSync",
          syncIdNeededForCompletion,
        });
      } else {
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
    await this.waitForInflightSends();

    const pending = await this.storage.getOutbox();

    // Reset unconfirmed transport states back to queued so they can retry.
    for (const tx of pending) {
      if (tx.state === "sent" && tx.retryCount < MAX_RETRY_COUNT) {
        tx.state = "queued";
        await this.storage.updateOutboxTransaction(tx.clientTxId, {
          state: "queued",
        });
        this.onTransactionStateChange?.(tx);
      }
    }

    // Filter to only queued transactions
    const queued = pending.filter(
      (tx) => tx.state === "queued" && tx.retryCount < MAX_RETRY_COUNT
    );

    if (queued.length === 0) {
      return;
    }

    // Send in batches
    for (let i = 0; i < queued.length; i += this.maxBatchSize) {
      const batch = queued.slice(i, i + this.maxBatchSize);
      await this.dispatchBatch(batch);
    }
  }

  private async flushPendingBatchNow(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    if (this.pendingBatch.length === 0) {
      return;
    }

    const batch = this.pendingBatch;
    this.pendingBatch = [];
    await this.dispatchBatch(batch);
  }

  /**
   * Gets the count of pending transactions
   */
  async getPendingCount(): Promise<number> {
    const outbox = await this.storage.getOutbox();
    return outbox.filter(
      (tx) =>
        tx.state === "queued" ||
        tx.state === "sent" ||
        tx.state === "awaitingSync"
    ).length;
  }

  /**
   * Returns the set of clientTxIds created by this runtime instance.
   */
  getLocalClientTxIds(): ReadonlySet<string> {
    return this.localClientTxIds;
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
        await this.storage.removeFromOutbox(tx.clientTxId);
        this.localClientTxIds.delete(tx.clientTxId);
        tx.state = "completed";
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
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.pendingBatch = [];
    this.localClientTxIds.clear();
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
