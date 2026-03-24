"use client";

import { SyncProvider } from "@stratasync/react";
import { motion } from "motion/react";

import { DevicePanel } from "./device-panel";
import { SyncDemoSkeleton } from "./sync-demo-skeleton";
import { SyncFlow } from "./sync-flow";
import { useDemoClients } from "./use-simulated-sync";

export const SyncDemo = () => {
  const demoClients = useDemoClients();

  if (!demoClients) {
    return <SyncDemoSkeleton />;
  }

  const { clientA, clientB, transportA, transportB, activeSyncAnimations } =
    demoClients;

  return (
    <motion.div
      animate={{ opacity: 1 }}
      className="grid grid-cols-1 items-center gap-4 md:grid-cols-[1fr_48px_1fr]"
      initial={{ opacity: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
    >
      <SyncProvider autoStop={false} client={clientA}>
        <DevicePanel label="Device A" transport={transportA} />
      </SyncProvider>

      <SyncFlow animations={activeSyncAnimations} />

      <SyncProvider autoStop={false} client={clientB}>
        <DevicePanel label="Device B" transport={transportB} />
      </SyncProvider>
    </motion.div>
  );
};
