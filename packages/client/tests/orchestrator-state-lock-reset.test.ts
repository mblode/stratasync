/**
 * The state lock must stay exclusive across a stop()/start(). Found by the
 * Lean model in verification/lean/StrataSync/Orchestrator.lean
 * (`bug_state_lock_overlaps_across_reset`).
 */
import { noopReactivityAdapter } from "@stratasync/core";

import { IdentityMapRegistry } from "../src/identity-map";
import { SyncOrchestrator } from "../src/sync-orchestrator";
import type { StorageAdapter, TransportAdapter } from "../src/types";

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
  // oxlint-disable-next-line avoid-new -- let timers/microtasks drain
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
};

const createOrchestrator = (): SyncOrchestrator => {
  const transport = {
    close: () => Promise.resolve(),
    onConnectionStateChange: () => () => {
      // nothing to detach
    },
  } as unknown as TransportAdapter;
  return new SyncOrchestrator(
    {
      clientId: "client-1",
      reactivity: noopReactivityAdapter,
      schema: { models: {} },
      storage: {} as StorageAdapter,
      transport,
    },
    new IdentityMapRegistry(noopReactivityAdapter)
  );
};

describe("SyncOrchestrator state lock across reset", () => {
  it("does not let the next run's state-lock work overlap a cancelled run's", async () => {
    const orchestrator = createOrchestrator();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    let releaseOld: (() => void) | null = null;

    const critical = async (
      name: string,
      body: () => Promise<void>
    ): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`${name}:start`);
      await body();
      order.push(`${name}:end`);
      active -= 1;
    };

    // An operation of the old run holds the state lock (e.g. a mutation or a
    // coverage load mid-write) when stop() lands.
    const oldOp = orchestrator.runWithStateLock(() =>
      critical(
        "old",
        () =>
          // oxlint-disable-next-line avoid-new -- held open by the test
          new Promise<void>((resolve) => {
            releaseOld = resolve;
          })
      )
    );
    await settle();

    await orchestrator.reset();

    // The next run takes the state lock while the old operation still runs.
    const newOp = orchestrator.runWithStateLock(() =>
      critical("new", () => Promise.resolve())
    );
    await settle();

    expect(order).toEqual(["old:start"]);

    (releaseOld as (() => void) | null)?.();
    await Promise.all([oldOp, newOp]);

    expect(maxActive).toBe(1);
    expect(order).toEqual(["old:start", "old:end", "new:start", "new:end"]);
  });
});
