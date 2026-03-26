/* eslint-disable react-perf/jsx-no-new-function-as-prop */
"use client";

import { usePendingCount, useQuery, useSyncClient } from "@stratasync/react";
import { useCallback, useState } from "react";

import type { DemoTransport } from "../demo-transport";
import { NetworkToggle } from "../network-toggle";
import { SyncIndicator } from "../sync-indicator";
import type { Layer } from "../types";
import { DesignCanvas } from "./design-canvas";

export const DesignPanel = ({
  label,
  transport,
}: {
  label: string;
  transport: DemoTransport;
}) => {
  const { client, state } = useSyncClient();
  const { count: pendingCount, hasPending } = usePendingCount();
  const { data: layers } = useQuery<Layer>("Layer", {
    orderBy: (a, b) => a.order - b.order,
  });

  const [isOnline, setIsOnline] = useState(true);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);

  const handleCanvasUpdate = useCallback(
    (layerId: string, changes: Partial<Layer>) => {
      client.update("Layer", layerId, changes);
    },
    [client]
  );

  const handleToggleNetwork = () => {
    const next = !isOnline;
    setIsOnline(next);
    transport.setOnline(next);
  };

  return (
    <section
      aria-label={label}
      className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card"
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-medium text-xs">{label}</span>
          <SyncIndicator isOnline={isOnline} status={state} />
        </div>
        <div className="ml-auto flex items-center gap-1">
          {hasPending && (
            <span
              aria-label={`${pendingCount} change${pendingCount === 1 ? "" : "s"} pending`}
              className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-100 px-1.5 font-medium text-amber-700 text-xs dark:bg-amber-900/30 dark:text-amber-400"
            >
              {pendingCount}
            </span>
          )}
          <NetworkToggle isOnline={isOnline} onToggle={handleToggleNetwork} />
        </div>
      </div>

      {/* Canvas */}
      <DesignCanvas
        layers={layers}
        onSelect={setSelectedLayerId}
        onUpdateLayer={handleCanvasUpdate}
        selectedId={selectedLayerId}
      />
    </section>
  );
};
