"use client";

import { useCallback, useSyncExternalStore } from "react";

import type { DemoTransport, WireItem } from "@/components/demo/demo-transport";

const EMPTY: readonly WireItem[] = Object.freeze([]);
const empty = () => EMPTY;
const noop = () => {
  /* no transport yet */
};

/** What is in flight on one device's wire right now, oldest first. */
export const useWire = (
  transport: DemoTransport | null
): readonly WireItem[] => {
  const subscribe = useCallback(
    (listener: () => void) => transport?.onWireChange(listener) ?? noop,
    [transport]
  );
  const snapshot = useCallback(
    () => transport?.getWire() ?? EMPTY,
    [transport]
  );

  return useSyncExternalStore(subscribe, snapshot, empty);
};
