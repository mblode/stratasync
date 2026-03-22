import type {
  ConnectionState,
  SyncClientState,
  SyncId,
} from "@stratasync/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  SyncBacklogContext,
  SyncClientContext,
  SyncContext,
  SyncStatusContext,
} from "./context.js";
import type {
  SyncContextValue,
  SyncProviderProps,
  SyncStatusContextValue,
} from "./types.js";

/**
 * Provider component for the sync client
 */
export const SyncProvider = ({
  client,
  children,
  autoStart = true,
  autoStop = true,
}: SyncProviderProps): ReactNode => {
  const [state, setState] = useState<SyncClientState>(client.state);
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    client.connectionState
  );
  const lastSyncIdRef = useRef<SyncId>(client.lastSyncId);
  const [backlog, setBacklog] = useState<number>(0);
  const [error, setError] = useState<Error | null>(client.lastError ?? null);

  useEffect(() => {
    let mounted = true;

    // Subscribe to state changes
    const unsubState = client.onStateChange((nextState) => {
      if (mounted) {
        setState(nextState);
      }
    });
    const unsubConnection = client.onConnectionStateChange((nextState) => {
      if (mounted) {
        setConnectionState(nextState);
      }
    });
    const unsubEvents = client.onEvent((event) => {
      if (!mounted) {
        return;
      }
      switch (event.type) {
        case "syncComplete": {
          lastSyncIdRef.current = event.lastSyncId;
          break;
        }
        case "stateChange": {
          if (event.state !== "error") {
            setError(null);
          }
          break;
        }
        case "syncError": {
          setError(event.error);
          break;
        }
        case "outboxChange": {
          setBacklog(event.pendingCount);
          break;
        }
        default: {
          break;
        }
      }
    });

    // Sync initial state
    setState(client.state);
    setConnectionState(client.connectionState);
    lastSyncIdRef.current = client.lastSyncId;
    setError(client.lastError ?? null);
    (async () => {
      try {
        const count = await client.getPendingCount();
        if (mounted) {
          setBacklog(count);
        }
      } catch {
        // Storage may not be open yet; backlog will update via outboxChange event
      }
    })();

    if (autoStart) {
      const startClient = async () => {
        try {
          await client.start();
        } catch (startError) {
          if (mounted) {
            setError(
              startError instanceof Error
                ? startError
                : new Error(String(startError))
            );
          }
        }
      };

      startClient();
    }

    return () => {
      mounted = false;
      unsubState();
      unsubConnection();
      unsubEvents();
      if (autoStop) {
        // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
        client.stop().catch(() => {
          /* noop */
        });
      }
    };
  }, [client, autoStart, autoStop]);

  const statusValue = useMemo<SyncStatusContextValue>(
    () => ({
      clientId: client.clientId,
      connectionState,
      error,
      isOffline: connectionState === "disconnected",
      isReady: state === "syncing",
      isSyncing: state === "syncing" || state === "bootstrapping",
      get lastSyncId() {
        return lastSyncIdRef.current;
      },
      state,
    }),
    [state, connectionState, error, client.clientId]
  );

  const value = useMemo<SyncContextValue>(
    () => ({
      backlog,
      client,
      ...statusValue,
    }),
    [client, backlog, statusValue]
  );

  return (
    <SyncClientContext.Provider value={client}>
      <SyncStatusContext.Provider value={statusValue}>
        <SyncBacklogContext.Provider value={backlog}>
          <SyncContext.Provider value={value}>{children}</SyncContext.Provider>
        </SyncBacklogContext.Provider>
      </SyncStatusContext.Provider>
    </SyncClientContext.Provider>
  );
};
