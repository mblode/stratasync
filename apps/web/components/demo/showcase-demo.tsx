/* eslint-disable react-perf/jsx-no-new-function-as-prop */
"use client";

import { SyncProvider } from "@stratasync/react";

import { SyncDemoSkeleton } from "./sync-demo-skeleton";
import { SyncFlow } from "./sync-flow";
import type { DemoVariant } from "./types";
import { useDemoClients } from "./use-simulated-sync";

export const ShowcaseDemo = ({ variant }: { variant: DemoVariant }) => {
  const demoClients = useDemoClients(
    variant.schema,
    variant.seedRows,
    variant.latencyMs
  );

  if (!demoClients) {
    return <SyncDemoSkeleton />;
  }

  const { clientA, clientB, transportA, transportB, activeSyncAnimations } =
    demoClients;
  const Panel = variant.panelComponent;

  return (
    <div className="grid grid-cols-1 items-center gap-4 md:grid-cols-[1fr_48px_1fr]">
      <SyncProvider autoStop={false} client={clientA}>
        <Panel label="Device A" transport={transportA} />
      </SyncProvider>

      <SyncFlow animations={activeSyncAnimations} />

      <SyncProvider autoStop={false} client={clientB}>
        <Panel label="Device B" transport={transportB} />
      </SyncProvider>
    </div>
  );
};
