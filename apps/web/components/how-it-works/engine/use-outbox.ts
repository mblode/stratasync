"use client";

import type { Transaction } from "@stratasync/core";
import { useCallback, useSyncExternalStore } from "react";

import type { ObservableStorage } from "./observable-storage";

const EMPTY: readonly Transaction[] = Object.freeze([]);
const empty = () => EMPTY;
const noop = () => {
  /* no storage yet */
};

/**
 * The real persisted outbox, live. See `ObservableStorage` for why this does
 * not come from `client.onEvent()`.
 */
export const useOutbox = (
  storage: ObservableStorage | null
): readonly Transaction[] => {
  const subscribe = useCallback(
    (listener: () => void) => storage?.subscribeToOutbox(listener) ?? noop,
    [storage]
  );
  const snapshot = useCallback(
    () => storage?.getOutboxSnapshot() ?? EMPTY,
    [storage]
  );

  return useSyncExternalStore(subscribe, snapshot, empty);
};
