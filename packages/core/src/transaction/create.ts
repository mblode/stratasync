import { generateClientTxId } from "../utils/idempotency.js";
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
const createTransaction = (options: CreateTransactionOptions): Transaction => {
  const tx: Transaction = {
    action: options.action,
    clientId: options.clientId,
    clientTxId: generateClientTxId(),
    createdAt: Date.now(),
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
  transactions: Transaction[]
): TransactionBatch => ({
  batchId: generateClientTxId(),
  createdAt: Date.now(),
  transactions,
});

/**
 * Creates an INSERT transaction for a new model instance
 */
export const createInsertTransaction = (
  clientId: string,
  modelName: string,
  modelId: string,
  data: Record<string, unknown>
): Transaction =>
  createTransaction({
    action: "I",
    clientId,
    modelId,
    modelName,
    payload: data,
  });

/**
 * Creates an UPDATE transaction for an existing model instance
 */
export const createUpdateTransaction = (
  clientId: string,
  modelName: string,
  modelId: string,
  changes: Record<string, unknown>,
  original: Record<string, unknown>
): Transaction =>
  createTransaction({
    action: "U",
    clientId,
    modelId,
    modelName,
    original,
    payload: changes,
  });

/**
 * Creates a DELETE transaction for removing a model instance
 */
export const createDeleteTransaction = (
  clientId: string,
  modelName: string,
  modelId: string,
  original: Record<string, unknown>
): Transaction =>
  createTransaction({
    action: "D",
    clientId,
    modelId,
    modelName,
    original,
    payload: { ...original },
  });

/**
 * Creates an ARCHIVE transaction for soft-deleting a model instance
 */
export const createArchiveTransaction = (
  clientId: string,
  modelName: string,
  modelId: string,
  options: ArchiveTransactionOptions = {}
): Transaction =>
  createTransaction({
    action: "A",
    clientId,
    modelId,
    modelName,
    original: options.original,
    payload: createArchivePayload(options.archivedAt),
  });

/**
 * Creates an UNARCHIVE transaction for restoring a soft-deleted model instance
 */
export const createUnarchiveTransaction = (
  clientId: string,
  modelName: string,
  modelId: string,
  options: UnarchiveTransactionOptions = {}
): Transaction =>
  createTransaction({
    action: "V",
    clientId,
    modelId,
    modelName,
    original: options.original,
    payload: createUnarchivePayload(),
  });

/**
 * Creates an undo transaction for a given transaction.
 */
export const createUndoTransaction = (
  tx: Transaction,
  clientId: string = tx.clientId
): Transaction | null => {
  switch (tx.action) {
    case "I": {
      return createDeleteTransaction(
        clientId,
        tx.modelName,
        tx.modelId,
        tx.payload
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
        tx.original
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
        tx.original,
        tx.payload
      );
    }
    case "A": {
      return createUnarchiveTransaction(clientId, tx.modelName, tx.modelId, {
        original: captureArchiveState(tx.payload),
      });
    }
    case "V": {
      return createArchiveTransaction(clientId, tx.modelName, tx.modelId, {
        archivedAt: readArchivedAt(tx.original),
        original: createUnarchivePatch(),
      });
    }
    default: {
      return null;
    }
  }
};
