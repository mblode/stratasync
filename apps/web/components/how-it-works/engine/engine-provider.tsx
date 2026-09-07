/* oxlint-disable eslint-plugin-promise/prefer-await-to-then -- teardown is fire-and-forget */
"use client";

import { createSyncClient } from "@stratasync/client";
import type { SyncClient } from "@stratasync/client";
import { createMobXReactivity } from "@stratasync/mobx";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";

import { DemoServer, DemoTransport } from "@/components/demo/demo-transport";

import { ObservableStorage } from "./observable-storage";
import { ScenarioRegistry } from "./scenario-registry";
import { howItWorksSchema } from "./scenarios";

export interface Engine {
  clientA: SyncClient;
  clientB: SyncClient;
  registry: ScenarioRegistry;
  server: DemoServer;
  storageA: ObservableStorage;
  storageB: ObservableStorage;
  transportA: DemoTransport;
  transportB: DemoTransport;
}

const EngineContext = createContext<Engine | null>(null);

/** Null until the effect below has run, which is client-only by construction. */
export const useEngine = (): Engine | null => useContext(EngineContext);

const ignore = () => {
  /* teardown failures are not the reader's problem */
};

/**
 * One server, two devices, for the whole page.
 *
 * Built in an effect rather than in render because a sync client opens storage
 * and a transport subscription, neither of which belongs in a server render —
 * the same reason `use-simulated-sync.ts` does it this way.
 */
export const EngineProvider = ({ children }: { children: ReactNode }) => {
  const [engine, setEngine] = useState<Engine | null>(null);

  useEffect(() => {
    const server = new DemoServer([]);
    const transportA = new DemoTransport(server, "A");
    const transportB = new DemoTransport(server, "B");
    const storageA = new ObservableStorage();
    const storageB = new ObservableStorage();
    const reactivity = createMobXReactivity();

    const clientA = createSyncClient({
      dbName: "how-it-works-a",
      optimistic: true,
      reactivity,
      schema: howItWorksSchema,
      storage: storageA,
      transport: transportA,
    });

    const clientB = createSyncClient({
      dbName: "how-it-works-b",
      optimistic: true,
      reactivity,
      schema: howItWorksSchema,
      storage: storageB,
      transport: transportB,
    });

    setEngine({
      clientA,
      clientB,
      registry: new ScenarioRegistry(),
      server,
      storageA,
      storageB,
      transportA,
      transportB,
    });

    return () => {
      clientA.stop().catch(ignore);
      clientB.stop().catch(ignore);
      transportA.close().catch(ignore);
      transportB.close().catch(ignore);
    };
  }, []);

  return (
    <EngineContext.Provider value={engine}>{children}</EngineContext.Provider>
  );
};
