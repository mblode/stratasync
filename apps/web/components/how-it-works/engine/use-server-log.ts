"use client";

import type { SyncAction } from "@stratasync/core";
import { useCallback, useSyncExternalStore } from "react";

import type { DemoServer } from "@/components/demo/demo-transport";

const EMPTY: readonly SyncAction[] = Object.freeze([]);
const empty = () => EMPTY;
const noop = () => {
  /* no server yet */
};

/** The server's ordered log, live. Ids are whatever the server assigned. */
export const useServerLog = (
  server: DemoServer | null
): readonly SyncAction[] => {
  const subscribe = useCallback(
    (listener: () => void) => server?.onLogAppend(listener) ?? noop,
    [server]
  );
  const snapshot = useCallback(() => server?.getLog() ?? EMPTY, [server]);

  return useSyncExternalStore(subscribe, snapshot, empty);
};
