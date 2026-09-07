"use client";

import type { SyncClient, SyncClientEvent } from "@stratasync/client";
import type {
  ConnectionState,
  SyncClientState,
  SyncId,
} from "@stratasync/core";
import { useCallback, useMemo, useSyncExternalStore } from "react";

export interface Telemetry {
  catchingUp: boolean;
  connection: ConnectionState;
  lastConflict: { conflictType: string; resolution: string } | null;
  lastSyncId: SyncId;
  pendingCount: number;
  state: SyncClientState;
}

const IDLE: Telemetry = Object.freeze({
  catchingUp: false,
  connection: "disconnected",
  lastConflict: null,
  lastSyncId: "0",
  pendingCount: 0,
  state: "disconnected",
});

const idle = () => IDLE;
const noop = () => {
  /* no client yet */
};

const fold = (current: Telemetry, event: SyncClientEvent): Telemetry => {
  switch (event.type) {
    case "catchUpChange": {
      return Object.freeze({ ...current, catchingUp: event.catchingUp });
    }
    case "connectionChange": {
      return Object.freeze({ ...current, connection: event.state });
    }
    case "outboxChange": {
      return Object.freeze({ ...current, pendingCount: event.pendingCount });
    }
    case "rebaseConflict": {
      return Object.freeze({
        ...current,
        lastConflict: Object.freeze({
          conflictType: event.conflictType,
          resolution: event.resolution,
        }),
      });
    }
    case "stateChange": {
      return Object.freeze({ ...current, state: event.state });
    }
    case "syncComplete": {
      return Object.freeze({ ...current, lastSyncId: event.lastSyncId });
    }
    default: {
      return current;
    }
  }
};

const createStore = (client: SyncClient) => {
  const listeners = new Set<() => void>();
  let snapshot: Telemetry = Object.freeze({
    catchingUp: client.catchingUp,
    connection: client.connectionState,
    lastConflict: null,
    lastSyncId: client.lastSyncId,
    pendingCount: 0,
    state: client.state,
  });
  let detach: (() => void) | null = null;

  return {
    getSnapshot: () => snapshot,
    /*
     * The client subscription is attached lazily by the first React subscriber
     * and dropped by the last, so nothing is subscribed during render and the
     * store needs no separate disposal effect.
     */
    subscribe: (listener: () => void) => {
      if (listeners.size === 0) {
        detach = client.onEvent((event) => {
          const next = fold(snapshot, event);
          if (next !== snapshot) {
            snapshot = next;
            for (const l of listeners) {
              l();
            }
          }
        });
      }
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          detach?.();
          detach = null;
        }
      };
    },
  };
};

/**
 * One `onEvent` subscription per client, folded into a frozen snapshot.
 *
 * Not `observer()` from `mobx-react-lite`: that is not a dependency of this
 * app, and adding one to read six event types is exactly the dependency the
 * codebase avoids.
 */
export const useClientTelemetry = (client: SyncClient | null): Telemetry => {
  const store = useMemo(() => (client ? createStore(client) : null), [client]);

  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(listener) ?? noop,
    [store]
  );
  const snapshot = useCallback(() => store?.getSnapshot() ?? IDLE, [store]);

  return useSyncExternalStore(subscribe, snapshot, idle);
};
