"use client";

import { SyncProvider } from "@stratasync/react";

import { DevicePanel } from "./device-panel";
import { SyncFlow } from "./sync-flow";
import { useDemoClients } from "./use-simulated-sync";

export const SyncDemo = () => {
  const { clientA, clientB, transportA, transportB, activeSyncAnimations } =
    useDemoClients();

  return (
    <section className="py-16">
      <div className="container-wrapper">
        <div className="mx-auto max-w-3xl space-y-6">
          <div className="space-y-2 text-center">
            <h2 className="font-semibold font-sans text-xl tracking-tight">
              See it in action
            </h2>
            <p className="mx-auto max-w-lg text-muted-foreground text-sm">
              Two devices, one shared state. Toggle offline, add todos, and
              watch changes sync in real-time.
            </p>
          </div>

          <div className="grid grid-cols-1 items-center gap-4 md:grid-cols-[1fr_48px_1fr]">
            <SyncProvider autoStop={false} client={clientA}>
              <DevicePanel label="Device A" transport={transportA} />
            </SyncProvider>

            <SyncFlow animations={activeSyncAnimations} />

            <SyncProvider autoStop={false} client={clientB}>
              <DevicePanel label="Device B" transport={transportB} />
            </SyncProvider>
          </div>
        </div>
      </div>
    </section>
  );
};
