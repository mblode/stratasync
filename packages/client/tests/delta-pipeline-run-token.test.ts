import type { DeltaPacket } from "@stratasync/core";
import { systemRuntime } from "@stratasync/core";

import { AsyncQueue } from "../src/internal/async-queue.js";
import { Gate } from "../src/internal/gate.js";
import type { SyncContext } from "../src/sync/context.js";
import { SyncCursor } from "../src/sync/cursor.js";
import { DeltaPipeline } from "../src/sync/delta-pipeline.js";
import type { StorageAdapter, TransportAdapter } from "../src/types.js";

const deferred = <T>() => Promise.withResolvers<T>();

/** Lets detached continuations (timers included) run to completion. */
const settle = (): Promise<void> =>
  // oxlint-disable-next-line avoid-new -- wait on a real timer tick
  new Promise((resolve) => {
    setTimeout(resolve, 10);
  });

/** An iterator whose `next()` never settles unless the test settles it. */
const pendingIterator = (
  next: () => Promise<IteratorResult<DeltaPacket>>
): AsyncIterator<DeltaPacket> => ({
  next,
  return: () => Promise.resolve({ done: true, value: undefined }),
});

/**
 * Context with a controllable run token. `restart()` simulates stop() +
 * start(): the lifecycle is running again under a new token, which is exactly
 * when an `isRunning()` check stops distinguishing the runs.
 */
const createHarness = (options: {
  subscribe?: () => AsyncIterator<DeltaPacket>;
  runBootstrap?: () => Promise<void>;
  processOutboxTransactions?: () => Promise<void>;
  runWithStateLock?: <T>(operation: () => Promise<T>) => Promise<T>;
}) => {
  let runToken = 1;
  let subscription: AsyncIterator<DeltaPacket> | null = null;
  let groupChangePending = false;
  const subscribeCalls: number[] = [];
  const bootstrapTokens: number[] = [];
  const states: { state: string; token: number }[] = [];
  const packetQueue = new AsyncQueue();
  const gate = new Gate();
  const storage = {
    setMeta: () => Promise.resolve(),
  } as unknown as StorageAdapter;

  const ctx = {
    cursor: new SyncCursor(storage),
    deltaReplayGate: () => gate,
    getConnectionState: () => "connected",
    getDeltaSubscription: () => subscription,
    getGroups: () => [],
    getRunToken: () => runToken,
    identityMaps: {
      batch: (fn: () => void) => fn(),
      clearAll: () => {
        // Nothing cached in this harness.
      },
    },
    isGroupChangePending: () => groupChangePending,
    isRunActive: (token: number) => token === runToken,
    isRunning: () => true,
    packetQueue: () => packetQueue,
    recordError: () => {
      // Not observed.
    },
    runWithStateLock:
      options.runWithStateLock ??
      (<T>(operation: () => Promise<T>) => operation()),
    runtime: systemRuntime,
    setDeltaSubscription: (next: AsyncIterator<DeltaPacket> | null) => {
      subscription = next;
    },
    setGroupChangePending: (pending: boolean) => {
      groupChangePending = pending;
    },
    setGroups: () => {
      // Not observed.
    },
    setState: (state: string) => {
      states.push({ state, token: runToken });
    },
    storage,
    transport: {
      subscribe: () => {
        subscribeCalls.push(runToken);
        const iterator =
          options.subscribe?.() ??
          pendingIterator(
            () => deferred<IteratorResult<DeltaPacket>>().promise
          );
        return { [Symbol.asyncIterator]: () => iterator };
      },
    } as unknown as TransportAdapter,
  } as unknown as SyncContext;

  const pipeline = new DeltaPipeline(ctx, {
    applyPendingOutboxTransactions: () => Promise.resolve(),
    processOutboxTransactions:
      options.processOutboxTransactions ?? (() => Promise.resolve()),
    runBootstrap: (token: number) => {
      bootstrapTokens.push(token);
      return options.runBootstrap?.() ?? Promise.resolve();
    },
  });

  return {
    bootstrapTokens,
    ctx,
    pipeline,
    restart() {
      runToken += 1;
    },
    states,
    subscribeCalls,
  };
};

const bootstrapRequired = (): Error =>
  Object.assign(new Error("cursor too old"), { code: "BOOTSTRAP_REQUIRED" });

describe("DeltaPipeline continuations are bound to their run", () => {
  it("does not resubscribe into the next run when an old stream ends after a restart", async () => {
    const firstNext = deferred<IteratorResult<DeltaPacket>>();
    let subscribes = 0;
    const harness = createHarness({
      subscribe: () => {
        subscribes += 1;
        return subscribes === 1
          ? pendingIterator(() => firstNext.promise)
          : pendingIterator(
              () => deferred<IteratorResult<DeltaPacket>>().promise
            );
      },
    });

    harness.pipeline.startDeltaSubscription("10");
    await vi.waitFor(() => {
      expect(harness.subscribeCalls).toEqual([1]);
    });

    // stop() + start(): run 2 opens its own stream.
    harness.restart();
    const runTwoStream = pendingIterator(
      () => deferred<IteratorResult<DeltaPacket>>().promise
    );
    harness.ctx.setDeltaSubscription(runTwoStream);

    // Run 1's iterator only now reports the end of its stream.
    firstNext.resolve({ done: true, value: undefined });
    await settle();

    expect(harness.subscribeCalls).toEqual([1]);
    expect(harness.ctx.getDeltaSubscription()).toBe(runTwoStream);
  });

  it("still resubscribes when the stream ends within the same run", async () => {
    const firstNext = deferred<IteratorResult<DeltaPacket>>();
    let subscribes = 0;
    const harness = createHarness({
      subscribe: () => {
        subscribes += 1;
        return subscribes === 1
          ? pendingIterator(() => firstNext.promise)
          : pendingIterator(
              () => deferred<IteratorResult<DeltaPacket>>().promise
            );
      },
    });

    harness.pipeline.startDeltaSubscription("10");
    firstNext.resolve({ done: true, value: undefined });

    await vi.waitFor(() => {
      expect(harness.subscribeCalls).toEqual([1, 1]);
    });
  });

  it("does not resume the stream or set state in the next run after a stale re-bootstrap", async () => {
    const outbox = deferred<null>();
    let outboxCalls = 0;
    const harness = createHarness({
      processOutboxTransactions: async () => {
        outboxCalls += 1;
        await outbox.promise;
      },
    });

    await harness.pipeline.handleBootstrapRequired(bootstrapRequired(), null);
    await vi.waitFor(() => {
      expect(outboxCalls).toBe(1);
    });

    // stop() + start() while run 1's resume is awaiting the outbox.
    harness.restart();
    outbox.resolve(null);
    await settle();

    expect(harness.bootstrapTokens).toEqual([1]);
    expect(harness.subscribeCalls).toEqual([]);
    expect(harness.states).toEqual([]);
  });

  it("does not run a stale re-bootstrap under the next run's token", async () => {
    const lock = deferred<null>();
    const harness = createHarness({
      runWithStateLock: async <T>(operation: () => Promise<T>) => {
        await lock.promise;
        return operation();
      },
    });

    await harness.pipeline.handleBootstrapRequired(bootstrapRequired(), null);
    // The lock is only granted after stop() + start().
    harness.restart();
    lock.resolve(null);
    await settle();

    expect(harness.bootstrapTokens).toEqual([]);
    expect(harness.subscribeCalls).toEqual([]);
    expect(harness.states).toEqual([]);
  });

  it("resumes the stream in the same run after a re-bootstrap", async () => {
    const harness = createHarness({});

    await harness.pipeline.handleBootstrapRequired(bootstrapRequired(), null);

    await vi.waitFor(() => {
      expect(harness.states).toEqual([{ state: "syncing", token: 1 }]);
    });
    expect(harness.bootstrapTokens).toEqual([1]);
    expect(harness.subscribeCalls).toEqual([1]);
  });
});
