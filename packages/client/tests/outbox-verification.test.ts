/* oxlint-disable max-classes-per-file */
/**
 * Regression tests for counterexamples found by the Lean model in
 * verification/lean/StrataSync/Outbox.lean.
 */
import type {
  CancelScheduled,
  MutateResult,
  SyncRuntime,
  Transaction,
  TransactionBatch,
} from "../../core/src/index";
import { OutboxManager } from "../src/outbox-manager";
import type { StorageAdapter, TransportAdapter } from "../src/types";

const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i += 1) {
    await Promise.resolve();
  }
};

/**
 * Outbox-only storage. Reads return structured clones, as IndexedDB does, so
 * the manager's in-memory objects are never aliased with persisted rows.
 */
class OutboxStorage {
  readonly rows: Transaction[] = [];
  /** Runs when a read starts; the snapshot is taken a few ticks later. */
  onReadStart: (() => void) | null = null;

  async getOutbox(): Promise<Transaction[]> {
    const hook = this.onReadStart;
    this.onReadStart = null;
    hook?.();
    await settle();
    return this.rows.map((tx) => structuredClone(tx));
  }

  addToOutbox(tx: Transaction): Promise<void> {
    this.rows.push(structuredClone(tx));
    return Promise.resolve();
  }

  removeFromOutbox(clientTxId: string): Promise<void> {
    const index = this.rows.findIndex((tx) => tx.clientTxId === clientTxId);
    if (index !== -1) {
      this.rows.splice(index, 1);
    }
    return Promise.resolve();
  }

  updateOutboxTransaction(
    clientTxId: string,
    updates: Partial<Transaction>
  ): Promise<void> {
    const tx = this.rows.find((entry) => entry.clientTxId === clientTxId);
    if (tx) {
      Object.assign(tx, updates);
    }
    return Promise.resolve();
  }
}

class ManualRuntime implements SyncRuntime {
  private timers: (() => void)[] = [];
  private ids = 0;

  now(): number {
    return 1000;
  }

  schedule(callback: () => void, _ms: number): CancelScheduled {
    this.timers.push(callback);
    return () => {
      this.timers = this.timers.filter((timer) => timer !== callback);
    };
  }

  fireTimers(): void {
    const due = this.timers;
    this.timers = [];
    for (const timer of due) {
      timer();
    }
  }

  newTransactionId(): string {
    this.ids += 1;
    return `tx-${this.ids}`;
  }

  newId(): string {
    this.ids += 1;
    return `id-${this.ids}`;
  }
}

const createManager = (
  storage: OutboxStorage,
  runtime: ManualRuntime,
  mutate: (batch: TransactionBatch) => Promise<MutateResult>,
  onTransactionRejected?: (tx: Transaction) => void
): OutboxManager =>
  new OutboxManager({
    clientId: "client-1",
    onTransactionRejected,
    runtime,
    storage: storage as unknown as StorageAdapter,
    transport: { mutate } as unknown as TransportAdapter,
  });

/**
 * A server that applies each transaction at most once (dedup by clientTxId,
 * like MutateService) and rejects an update or delete of a row it has never
 * seen, like MutateService does.
 */
const createServer = (failFirstCalls: number) => {
  const rows = new Set<string>();
  const applied = new Map<string, string>();
  const received: string[][] = [];
  let syncId = 0;
  const mutate = (batch: TransactionBatch): Promise<MutateResult> => {
    received.push(batch.transactions.map((tx) => tx.clientTxId));
    if (received.length <= failFirstCalls) {
      return Promise.reject(new Error("request timed out"));
    }
    const results = batch.transactions.map((tx) => {
      const existing = applied.get(tx.clientTxId);
      if (existing) {
        return { clientTxId: tx.clientTxId, success: true, syncId: existing };
      }
      if (tx.action !== "I" && !rows.has(tx.modelId)) {
        return {
          clientTxId: tx.clientTxId,
          error: `${tx.modelName} ${tx.modelId} not found`,
          success: false,
        };
      }
      rows.add(tx.modelId);
      syncId += 1;
      applied.set(tx.clientTxId, String(syncId));
      return {
        clientTxId: tx.clientTxId,
        success: true,
        syncId: String(syncId),
      };
    });
    return Promise.resolve({
      lastSyncId: String(syncId),
      results,
      success: true,
    });
  };
  return { applied, mutate, received };
};

describe("OutboxManager (Lean counterexamples)", () => {
  it("never delivers a later mutation ahead of an earlier one that hit a transient transport failure", async () => {
    const storage = new OutboxStorage();
    const runtime = new ManualRuntime();
    const server = createServer(1);
    const rejected: Transaction[] = [];
    const manager = createManager(storage, runtime, server.mutate, (tx) =>
      rejected.push(tx)
    );

    // create X: the REST call times out, the transaction stays queued.
    const create = await manager.insert("Task", "task-1", { id: "task-1" });
    runtime.fireTimers();
    await settle();
    expect(server.received).toEqual([[create.clientTxId]]);

    // update X while the delta socket is still connected (no reconnect, so no
    // processPendingTransactions): the next batch must carry the create first.
    const update = await manager.update(
      "Task",
      "task-1",
      { title: "Renamed" },
      { title: "Draft" }
    );
    runtime.fireTimers();
    await settle();

    expect(rejected).toEqual([]);
    expect(server.received[1]).toEqual([create.clientTxId, update.clientTxId]);
    expect(server.applied.has(update.clientTxId)).toBeTruthy();
  });

  it("does not resend a transaction still sitting in the pending batch while a reconnect drain runs", async () => {
    const storage = new OutboxStorage();
    const runtime = new ManualRuntime();
    const server = createServer(0);
    const gates: (() => void)[] = [];
    // oxlint-disable-next-line avoid-new -- a gate the test opens by hand
    const firstCallGate = new Promise<void>((resolve) => {
      gates.push(resolve);
    });
    const mutate = async (batch: TransactionBatch): Promise<MutateResult> => {
      if (server.received.length === 0) {
        await firstCallGate;
      }
      return server.mutate(batch);
    };
    const manager = createManager(storage, runtime, mutate);

    const first = await manager.insert("Task", "task-1", { id: "task-1" });
    // Reconnect drain starts: flushes [first] and waits for it to settle.
    const drain = manager.processPendingTransactions();
    await settle();

    // A new mutation is queued while the drain is waiting on the network.
    const second = await manager.insert("Task", "task-2", { id: "task-2" });
    gates.shift()?.();
    await drain;
    // The batch timer for `second` fires afterwards.
    runtime.fireTimers();
    await manager.flush();

    const sends = server.received.flat();
    expect(sends.filter((id) => id === first.clientTxId)).toHaveLength(1);
    expect(sends.filter((id) => id === second.clientTxId)).toHaveLength(1);
  });

  it("does not reset an in-flight transaction to queued and resend it during a drain", async () => {
    const storage = new OutboxStorage();
    const runtime = new ManualRuntime();
    const server = createServer(0);
    const gates: (() => void)[] = [];
    let calls = 0;
    const mutate = async (batch: TransactionBatch): Promise<MutateResult> => {
      calls += 1;
      if (calls <= 2) {
        // oxlint-disable-next-line avoid-new -- a gate the test opens by hand
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
      }
      return server.mutate(batch);
    };
    const manager = createManager(storage, runtime, mutate);

    await manager.insert("Task", "task-1", { id: "task-1" });
    const second = await manager.insert("Task", "task-2", { id: "task-2" });
    // The drain flushes both, and waits for that send to settle.
    const drain = manager.processPendingTransactions();
    await settle();
    const third = await manager.insert("Task", "task-3", { id: "task-3" });
    // The batch timer for task-3 fires just as the drain starts reading the
    // outbox, so task-3 is marked "sent" (in flight) before the read lands.
    storage.onReadStart = () => runtime.fireTimers();
    gates.shift()?.();
    await settle();
    await settle();
    gates.shift()?.();
    await drain;
    await manager.flush();

    const sends = server.received.flat();
    expect(sends.filter((id) => id === third.clientTxId)).toHaveLength(1);
    expect(sends.filter((id) => id === second.clientTxId)).toHaveLength(1);
  });

  it("does not carry a transport-failed transaction that was discarded since", async () => {
    const storage = new OutboxStorage();
    const runtime = new ManualRuntime();
    const server = createServer(1);
    const manager = createManager(storage, runtime, server.mutate);

    const dropped = await manager.insert("Task", "task-1", { id: "task-1" });
    runtime.fireTimers();
    await settle();
    // A rebase conflict resolves against it: the outbox drops it.
    await manager.discardTransaction(dropped.clientTxId);

    const kept = await manager.insert("Task", "task-2", { id: "task-2" });
    runtime.fireTimers();
    await settle();

    expect(server.received).toEqual([[dropped.clientTxId], [kept.clientTxId]]);
  });
});
