import { useContext } from "react";

import {
  SyncBacklogContext,
  SyncClientContext,
  SyncStatusContext,
} from "../context.js";
import type { SyncContextValue, SyncStatusContextValue } from "../types.js";

const SYNC_PROVIDER_ERROR = "useSyncClient must be used within a SyncProvider";

const useRequiredSyncClient = (): SyncContextValue["client"] => {
  const client = useContext(SyncClientContext);
  if (!client) {
    throw new Error(SYNC_PROVIDER_ERROR);
  }
  return client;
};

export const useSyncStatusValue = (): SyncStatusContextValue => {
  const status = useContext(SyncStatusContext);
  if (!status) {
    throw new Error(SYNC_PROVIDER_ERROR);
  }
  return status;
};

export const useSyncBacklogValue = (): number => {
  // Ensure hooks still throw a clear provider error when used outside context.
  useRequiredSyncClient();
  return useContext(SyncBacklogContext);
};

/**
 * Hook to access the sync client from context
 * @throws Error if used outside of SyncProvider
 */
export const useSyncClient = (): SyncContextValue => {
  const client = useRequiredSyncClient();
  const status = useSyncStatusValue();
  const backlog = useSyncBacklogValue();

  return { backlog, client, ...status };
};

/**
 * Hook to access just the sync client instance
 */
export const useSyncClientInstance = (): SyncContextValue["client"] =>
  useRequiredSyncClient();

/**
 * Hook to check if the sync client is ready
 */
export const useSyncReady = (): boolean => useSyncStatusValue().isReady;

/**
 * Hook to get the current sync state
 */
export const useSyncState = (): SyncContextValue["state"] =>
  useSyncStatusValue().state;

/**
 * Hook to get the latest sync error.
 */
export const useSyncError = (): Error | null => useSyncStatusValue().error;
