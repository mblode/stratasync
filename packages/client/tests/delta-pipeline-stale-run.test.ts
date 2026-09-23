import type { DeltaPacket, SyncAction } from "@stratasync/core";
import { systemRuntime } from "@stratasync/core";

import { AsyncQueue } from "../src/internal/async-queue.js";
import { Gate } from "../src/internal/gate.js";
import type { SyncContext } from "../src/sync/context.js";
import { SyncCursor } from "../src/sync/cursor.js";
import { DeltaPipeline } from "../src/sync/delta-pipeline.js";
import type { StorageAdapter, TransportAdapter } from "../src/types.js";

const action = (id: string): SyncAction => ({
  action: "U",
  data: { id: "task-1", title: `v${id}` },
  id,
  modelId: "task-1",
  modelName: "Task",
});

/**
 * Minimal context: the run token is controllable, and `runWithStateLock`
 * records every packet application instead of running it, so the test observes
 * exactly which buffered catch-up packets reach the apply step.
 */
const createHarness = (fetchDeltas: TransportAdapter["fetchDeltas"]) => {
  let running = true;
  let runToken = 1;
  let applications = 0;
  const packetQueue = new AsyncQueue();
  const gate = new Gate();
  const storage = {} as StorageAdapter;
  const ctx = {
    cursor: new SyncCursor(storage),
    deltaReplayGate: () => gate,
    getGroups: () => [],
    getRunToken: () => runToken,
    isRunActive: (token: number) => running && token === runToken,
    isRunning: () => running,
    packetQueue: () => packetQueue,
    runWithStateLock: () => {
      applications += 1;
      return Promise.resolve();
    },
    runtime: systemRuntime,
    setCatchingUp: () => {
      // Not observed by these tests.
    },
    storage,
    transport: { fetchDeltas } as unknown as TransportAdapter,
  } as unknown as SyncContext;

  const pipeline = new DeltaPipeline(ctx, {
    applyPendingOutboxTransactions: () => Promise.resolve(),
    processOutboxTransactions: () => Promise.resolve(),
    runBootstrap: () => Promise.resolve(),
  });

  return {
    get applications() {
      return applications;
    },
    pipeline,
    /** Simulates stop() followed by start(): a new, running run. */
    restart() {
      running = true;
      runToken += 1;
    },
  };
};

describe("DeltaPipeline catch-up across runs", () => {
  it("drops a buffered catch-up page when a later page fails after the run changed", async () => {
    let rejectSecond: ((error: Error) => void) | null = null;
    let calls = 0;
    const harness = createHarness(() => {
      calls += 1;
      if (calls === 1) {
        const packet: DeltaPacket = {
          actions: [action("11")],
          hasMore: true,
          lastSyncId: "11",
        };
        return Promise.resolve(packet);
      }
      // oxlint-disable-next-line avoid-new -- controlled in-flight fetch
      return new Promise<DeltaPacket>((_resolve, reject) => {
        rejectSecond = reject;
      });
    });

    const catchUp = harness.pipeline.fetchAndApplyDeltaPages("10", {
      maxAttempts: 2,
      runToken: 1,
      suppressFetchErrors: true,
    });

    // Let page 1 land in the buffer and page 2's fetch start.
    await vi.waitFor(() => {
      expect(rejectSecond).not.toBeNull();
    });

    // stop() + start(): the transport close fails the in-flight fetch only
    // once the next run is already active.
    harness.restart();
    (rejectSecond as unknown as (error: Error) => void)(
      new Error("transport closed")
    );
    await catchUp;

    // Run 1's buffered page must never be applied inside run 2.
    expect(harness.applications).toBe(0);
  });

  it("still flushes buffered pages when a later page fails within the same run", async () => {
    let calls = 0;
    const harness = createHarness(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          actions: [action("11")],
          hasMore: true,
          lastSyncId: "11",
        });
      }
      return Promise.reject(new Error("network down"));
    });

    await harness.pipeline.fetchAndApplyDeltaPages("10", {
      maxAttempts: 1,
      runToken: 1,
      suppressFetchErrors: true,
    });

    expect(harness.applications).toBe(1);
  });
});
