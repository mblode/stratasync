"use client";

import type { SyncClientState } from "@stratasync/core";
import { motion, useReducedMotion } from "motion/react";

import { cn } from "@/lib/utils";

const statusConfig: Record<
  SyncClientState,
  { color: string; label: string; pulse: boolean }
> = {
  bootstrapping: { color: "bg-amber-500", label: "Loading", pulse: true },
  connecting: { color: "bg-amber-500", label: "Connecting", pulse: true },
  disconnected: { color: "bg-gray-400", label: "Offline", pulse: false },
  error: { color: "bg-red-500", label: "Error", pulse: false },
  syncing: { color: "bg-emerald-500", label: "Synced", pulse: false },
};

export const SyncIndicator = ({ status }: { status: SyncClientState }) => {
  const reduceMotion = useReducedMotion();
  const config = statusConfig[status];

  return (
    <div
      aria-label={config.label}
      className="flex items-center gap-1.5"
      role="status"
    >
      <motion.div
        animate={
          config.pulse && !reduceMotion
            ? { opacity: [1, 0.7, 1], scale: [1, 1.2, 1] }
            : {
                opacity: status === "disconnected" ? 0.5 : 1,
                scale: 1,
              }
        }
        className={cn("h-1.5 w-1.5 rounded-full", config.color)}
        transition={
          config.pulse
            ? {
                duration: 1.2,
                ease: "easeInOut",
                repeat: Number.POSITIVE_INFINITY,
              }
            : { duration: 0.2 }
        }
      />
      <span className="text-muted-foreground text-xs">{config.label}</span>
    </div>
  );
};
