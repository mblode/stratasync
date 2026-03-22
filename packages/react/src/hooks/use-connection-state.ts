import { useCallback, useRef, useState } from "react";

import type {
  UseConnectionStateResult,
  UsePendingCountResult,
} from "../types.js";
import {
  useSyncBacklogValue,
  useSyncClientInstance,
  useSyncStatusValue,
} from "./use-sync-client.js";

/**
 * Hook to access the current connection state
 *
 * @example
 * ```tsx
 * function ConnectionStatus() {
 *   const { status, lastSyncId, backlog, error } = useConnectionState();
 *
 *   if (error) return <Badge color="red">Error</Badge>;
 *   if (status === 'bootstrapping') return <Badge>Bootstrapping...</Badge>;
 *   return <Badge>Sync ID: {lastSyncId} ({backlog} pending)</Badge>;
 * }
 * ```
 */
export const useConnectionState = (): UseConnectionStateResult => {
  const { state, lastSyncId, error } = useSyncStatusValue();
  const backlog = useSyncBacklogValue();

  return {
    backlog,
    error,
    lastSyncId,
    status: state,
  };
};

/**
 * Hook to get the count of pending (unsynced) transactions
 *
 * @example
 * ```tsx
 * function PendingIndicator() {
 *   const { count, hasPending } = usePendingCount();
 *
 *   if (!hasPending) return null;
 *   return <Badge>{count} changes pending sync</Badge>;
 * }
 * ```
 */
export const usePendingCount = (): UsePendingCountResult => {
  const backlog = useSyncBacklogValue();

  return {
    count: backlog,
    hasPending: backlog > 0,
  };
};

/**
 * Hook to check if the app is offline
 */
export const useIsOffline = (): boolean => {
  const { isOffline } = useSyncStatusValue();
  return isOffline;
};

/**
 * Hook to manually trigger a sync
 *
 * @example
 * ```tsx
 * function SyncButton() {
 *   const { sync, isSyncing } = useSync();
 *
 *   return (
 *     <button onClick={sync} disabled={isSyncing}>
 *       {isSyncing ? 'Syncing...' : 'Sync Now'}
 *     </button>
 *   );
 * }
 * ```
 */
export const useSync = (): {
  sync: () => Promise<void>;
  isSyncing: boolean;
} => {
  const client = useSyncClientInstance();
  const [isSyncing, setIsSyncing] = useState(false);
  const isSyncingRef = useRef(false);

  const sync = useCallback(async () => {
    if (isSyncingRef.current) {
      return;
    }

    isSyncingRef.current = true;
    setIsSyncing(true);
    try {
      await client.syncNow();
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }, [client]);

  return { isSyncing, sync };
};
