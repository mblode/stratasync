import type { Transaction, TransactionState } from "@stratasync/core";
import type { IDBPDatabase } from "idb";

/**
 * Store name for the transaction outbox
 */
export const TRANSACTION_STORE = "_transaction";

/**
 * Store name for sync actions
 */
export const SYNC_ACTION_STORE = "_sync_action";

/**
 * Maximum retry count before marking transaction as failed
 */
export const MAX_RETRY_COUNT = 5;

const hasTransactionStore = (db: IDBPDatabase): boolean =>
  db.objectStoreNames.contains(TRANSACTION_STORE);

const compareTransactions = (a: Transaction, b: Transaction): number => {
  const createdAtDiff = a.createdAt - b.createdAt;
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }

  const batchIndexDiff =
    (a.batchIndex ?? Number.MAX_SAFE_INTEGER) -
    (b.batchIndex ?? Number.MAX_SAFE_INTEGER);
  if (batchIndexDiff !== 0) {
    return batchIndexDiff;
  }

  return a.clientTxId.localeCompare(b.clientTxId);
};

/**
 * Gets all transactions from the outbox
 */
export const getAllTransactions = (
  db: IDBPDatabase
): Promise<Transaction[]> => {
  if (!hasTransactionStore(db)) {
    return Promise.resolve([]);
  }
  return db
    .getAllFromIndex(TRANSACTION_STORE, "byCreatedAt")
    .then((transactions) =>
      (transactions as Transaction[]).toSorted(compareTransactions)
    );
};

/**
 * Gets transactions by state
 */
export const getTransactionsByState = (
  db: IDBPDatabase,
  state: TransactionState
): Promise<Transaction[]> => {
  if (!hasTransactionStore(db)) {
    return Promise.resolve([]);
  }
  return db.getAllFromIndex(TRANSACTION_STORE, "byState", state) as Promise<
    Transaction[]
  >;
};

/**
 * Gets a transaction by its client transaction ID
 */
export const getTransaction = async (
  db: IDBPDatabase,
  clientTxId: string
): Promise<Transaction | null> => {
  if (!hasTransactionStore(db)) {
    return null;
  }
  const result = await db.get(TRANSACTION_STORE, clientTxId);
  return result ? (result as Transaction) : null;
};

/**
 * Adds a transaction to the outbox
 */
export const addTransaction = async (
  db: IDBPDatabase,
  tx: Transaction
): Promise<void> => {
  if (!hasTransactionStore(db)) {
    return;
  }
  await db.put(TRANSACTION_STORE, tx);
};

/**
 * Updates a transaction in the outbox
 */
export const updateTransaction = async (
  db: IDBPDatabase,
  clientTxId: string,
  updates: Partial<Transaction>
): Promise<void> => {
  if (!hasTransactionStore(db)) {
    return;
  }
  const tx = db.transaction(TRANSACTION_STORE, "readwrite");
  const store = tx.objectStore(TRANSACTION_STORE);
  const existing = (await store.get(clientTxId)) as Transaction | undefined;
  if (existing) {
    await store.put({ ...existing, ...updates });
  }
  await tx.done;
};

/**
 * Removes a transaction from the outbox
 */
export const removeTransaction = async (
  db: IDBPDatabase,
  clientTxId: string
): Promise<void> => {
  if (!hasTransactionStore(db)) {
    return;
  }
  await db.delete(TRANSACTION_STORE, clientTxId);
};

/**
 * Marks a transaction as failed
 */
export const markTransactionFailed = async (
  db: IDBPDatabase,
  clientTxId: string,
  error: string
): Promise<void> => {
  if (!hasTransactionStore(db)) {
    return;
  }

  const tx = db.transaction(TRANSACTION_STORE, "readwrite");
  const store = tx.objectStore(TRANSACTION_STORE);
  const existing = (await store.get(clientTxId)) as Transaction | undefined;

  if (existing) {
    await store.put({
      ...existing,
      lastError: error,
      retryCount: existing.retryCount + 1,
      state: "failed",
    } satisfies Transaction);
  }

  await tx.done;
};

/**
 * Requeues a failed transaction for retry
 */
export const requeueTransaction = async (
  db: IDBPDatabase,
  clientTxId: string
): Promise<boolean> => {
  if (!hasTransactionStore(db)) {
    return false;
  }

  const tx = db.transaction(TRANSACTION_STORE, "readwrite");
  const store = tx.objectStore(TRANSACTION_STORE);
  const existing = (await store.get(clientTxId)) as Transaction | undefined;
  if (!existing) {
    await tx.done;
    return false;
  }

  if (existing.retryCount >= MAX_RETRY_COUNT) {
    await tx.done;
    return false;
  }

  await store.put({
    ...existing,
    retryCount: existing.retryCount + 1,
    state: "queued",
  } satisfies Transaction);

  await tx.done;
  return true;
};

/**
 * Resets sent transactions back to queued (for reconnection)
 */
export const resetSentToQueued = async (db: IDBPDatabase): Promise<number> => {
  const sentTxs = await getTransactionsByState(db, "sent");
  if (sentTxs.length === 0) {
    return 0;
  }

  const tx = db.transaction(TRANSACTION_STORE, "readwrite");
  const store = tx.objectStore(TRANSACTION_STORE);

  const promises: Promise<IDBValidKey>[] = [];
  for (const sentTx of sentTxs) {
    promises.push(store.put({ ...sentTx, state: "queued" }));
  }

  await Promise.all([...promises, tx.done]);
  return sentTxs.length;
};

/**
 * Gets the count of pending transactions
 */
export const getPendingCount = async (db: IDBPDatabase): Promise<number> => {
  if (!hasTransactionStore(db)) {
    return 0;
  }
  const queued = await db.countFromIndex(
    TRANSACTION_STORE,
    "byState",
    "queued"
  );
  const sent = await db.countFromIndex(TRANSACTION_STORE, "byState", "sent");
  return queued + sent;
};

/**
 * Clears all transactions from the outbox
 */
export const clearOutbox = async (db: IDBPDatabase): Promise<void> => {
  if (!hasTransactionStore(db)) {
    return;
  }
  const tx = db.transaction(TRANSACTION_STORE, "readwrite");
  await tx.objectStore(TRANSACTION_STORE).clear();
  await tx.done;
};
