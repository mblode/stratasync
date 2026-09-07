"use client";

import type { RefObject } from "react";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { Engine } from "./engine-provider";
import { useEngine } from "./engine-provider";
import type { Scenario } from "./scenarios";

const noOwner = () => null;
const noVersion = () => 0;
const noop = () => {
  /* no engine yet */
};

export interface EngineCheckout {
  /** The shared engine, or null before the provider's effect has run. */
  engine: Engine | null;
  /**
   * Changes each time the scenario is applied. Key the live subtree on it, or
   * a reset leaves `useQuery` and `useSyncClient` showing the previous run.
   */
  generation: number;
  /** True while this figure holds the engine. Otherwise: render the poster. */
  live: boolean;
  /** Replay the scenario from scratch. What `Reset` means for a live figure. */
  reapply: () => void;
}

/**
 * Check the shared engine out for one figure.
 *
 * Handing over means: freeze both wires, wipe both devices, reseed the server,
 * then let everything through again. Freezing first is what stops a delta from
 * the previous scenario landing in the middle of the wipe.
 */
export const useEngineScenario = (
  scenario: Scenario,
  ref: RefObject<HTMLElement | null>,
  inView: boolean
): EngineCheckout => {
  const engine = useEngine();
  const { id, latencyMs, seed } = scenario;

  const apply = useCallback(async () => {
    if (!engine) {
      return;
    }
    const { clientA, clientB, server, transportA, transportB } = engine;

    /*
     * Only the downward wire is frozen for the wipe, and that is deliberate.
     * `clearAll()` awaits every in-flight send (`client.ts:677`), so a figure
     * that froze the upward wire — section 3 freezes both devices' — would
     * stall the handoff for good. Letting those sends land at zero latency
     * settles them at once, against a server that is reset on the next line.
     * Deltas stay held, which is the part that matters: it is a delta from the
     * previous scenario arriving mid-wipe that would corrupt the new one.
     */
    transportA.hold("down");
    transportB.hold("down");
    transportA.setLatency(0);
    transportB.setLatency(0);
    transportA.setOnline(true);
    transportB.setOnline(true);
    transportA.release("up");
    transportB.release("up");

    await clientA.clearAll();
    await clientB.clearAll();
    server.reset(seed);

    // `clearAll` resets each orchestrator, which closes its transport.
    transportA.reopen();
    transportB.reopen();
    transportA.setLatency(latencyMs);
    transportB.setLatency(latencyMs);
    transportA.release();
    transportB.release();

    await clientA.start();
    await clientB.start();
  }, [engine, latencyMs, seed]);

  const subscribe = useCallback(
    (listener: () => void) => engine?.registry.subscribe(listener) ?? noop,
    [engine]
  );
  const getOwner = useCallback(
    () => engine?.registry.getOwner() ?? null,
    [engine]
  );
  const getVersion = useCallback(
    () => engine?.registry.getVersion() ?? 0,
    [engine]
  );
  const owner = useSyncExternalStore(subscribe, getOwner, noOwner);
  const generation = useSyncExternalStore(subscribe, getVersion, noVersion);

  useEffect(() => {
    if (!engine) {
      return;
    }
    return engine.registry.register(id, ref.current, apply);
  }, [apply, engine, id, ref]);

  useEffect(() => {
    engine?.registry.setWanted(id, inView);
  }, [engine, id, inView]);

  const reapply = useCallback(() => {
    engine?.registry.reapply(id);
  }, [engine, id]);

  return {
    engine,
    generation,
    live: engine !== null && owner === id,
    reapply,
  };
};
