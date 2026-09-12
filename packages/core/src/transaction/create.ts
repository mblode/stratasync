import type { SyncRuntime } from "../runtime/index.js";
import { systemRuntime } from "../runtime/index.js";
import { replaceUndefinedWithNull } from "../utils/records.js";
import type {
  ArchiveTransactionOptions,
  UnarchiveTransactionOptions,
} from "./archive.js";
import {
  captureArchiveState,
  createArchivePayload,
  createUnarchivePatch,
  createUnarchivePayload,
  readArchivedAt,
} from "./archive.js";
import type {
  CreateTransactionOptions,
  Transaction,
  TransactionBatch,
} from "./types.js";

/**
 * Creates a new transaction with a unique client transaction ID
 */
const createTransaction = (
  options: CreateTransactionOptions,
  runtime: SyncRuntime
): Transaction => {
  const tx: Transaction = {
    action: options.action,
    clientId: options.clientId,
    clientTxId: runtime.newTransactionId(),
    createdAt: runtime.now(),
    modelId: options.modelId,
    modelName: options.modelName,
    payload: options.payload,
    retryCount: 0,
    state: "queued",
  };

  if (options.original !== undefined) {
    tx.original = options.original;
  }

  return tx;
};

/**
 * Creates a transaction batch from an array of transactions
 */
export const createTransactionBatch = (
  transactions: Transaction[],
  runtime: SyncRuntime = systemRuntime
): TransactionBatch => ({
  batchId: runtime.newId(),
  createdAt: runtime.now(),
  transactions,
});

/**
 * Creates an INSERT transaction for a new model instance
 */
export const createInsertTransaction = (
  clientId: string,
  modelName: string,
  modelId: string,
  data: Record<string, unknown>,
  runtime: SyncRuntime = systemRuntime
): Transaction =>
  createTransaction(
    {
      action: "I",
      clientId,
      modelId,
      modelName,
      payload: data,
    },
    runtime
  );

/**
 * Creates an UPDATE transaction for an existing model instance
 */
export const createUpdateTransaction = (
  clientId: string,
  modelName: string,
  modelId: string,
  changes: Record<string, unknown>,
  original: Record<string, unknown>,
  runtime: SyncRuntime = systemRuntime
): Transaction =>
  createTransaction(
    {
      action: "U",
      clientId,
      modelId,
      modelName,
      original,
      payload: changes,
    },
    runtime
  );

/**
 * Creates a DELETE transaction for removing a model instance
 */
export const createDeleteTransaction = (
  clientId: string,
  modelName: string,
  modelId: string,
  original: Record<string, unknown>,
  runtime: SyncRuntime = systemRuntime
): Transaction =>
  createTransaction(
    {
      action: "D",
      clientId,
      modelId,
      modelName,
      original,
      payload: { ...original },
    },
    runtime
  );

/**
 * Creates an ARCHIVE transaction for soft-deleting a model instance
 */
export const createArchiveTransaction = (
  clientId: string,
  modelName: string,
  modelId: string,
  options: ArchiveTransactionOptions = {},
  runtime: SyncRuntime = systemRuntime
): Transaction =>
  createTransaction(
    {
      action: "A",
      clientId,
      modelId,
      modelName,
      original: options.original,
      payload: createArchivePayload(options.archivedAt, runtime),
    },
    runtime
  );

/**
 * Creates an UNARCHIVE transaction for restoring a soft-deleted model instance
 */
export const createUnarchiveTransaction = (
  clientId: string,
  modelName: string,
  modelId: string,
  options: UnarchiveTransactionOptions = {},
  runtime: SyncRuntime = systemRuntime
): Transaction =>
  createTransaction(
    {
      action: "V",
      clientId,
      modelId,
      modelName,
      original: options.original,
      payload: createUnarchivePayload(),
    },
    runtime
  );

/**
 * Creates an undo transaction for a given transaction.
 *
 * Undoing an update restores the `original` snapshot; fields that had no value
 * before the change are sent as an explicit `null` so the server clears them
 * (an `undefined` member would be dropped from the JSON payload).
 */
export const createUndoTransaction = (
  tx: Transaction,
  clientId: string = tx.clientId,
  runtime: SyncRuntime = systemRuntime
): Transaction | null => {
  switch (tx.action) {
    case "I": {
      return createDeleteTransaction(
        clientId,
        tx.modelName,
        tx.modelId,
        tx.payload,
        runtime
      );
    }
    case "D": {
      if (!tx.original) {
        return null;
      }
      return createInsertTransaction(
        clientId,
        tx.modelName,
        tx.modelId,
        tx.original,
        runtime
      );
    }
    case "U": {
      if (!tx.original) {
        return null;
      }
      return createUpdateTransaction(
        clientId,
        tx.modelName,
        tx.modelId,
        replaceUndefinedWithNull(tx.original),
        tx.payload,
        runtime
      );
    }
    case "A": {
      return createUnarchiveTransaction(
        clientId,
        tx.modelName,
        tx.modelId,
        { original: captureArchiveState(tx.payload) },
        runtime
      );
    }
    case "V": {
      return createArchiveTransaction(
        clientId,
        tx.modelName,
        tx.modelId,
        {
          archivedAt: readArchivedAt(tx.original),
          original: createUnarchivePatch(),
        },
        runtime
      );
    }
    default: {
      return null;
    }
  }
};
