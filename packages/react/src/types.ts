import type { QueryOptions, SyncClient } from "@stratasync/client";
import type {
  ConnectionState,
  SyncClientState,
  SyncId,
} from "@stratasync/core";

/**
 * Sync provider props
 */
export interface SyncProviderProps {
  /** Sync client instance */
  client: SyncClient;
  /** Children to render */
  children: React.ReactNode;
  /** Automatically start the client */
  autoStart?: boolean;
  /** Automatically stop the client on unmount */
  autoStop?: boolean;
}

/**
 * Sync status context value (excluding pending backlog)
 */
export interface SyncStatusContextValue {
  /** Current sync state */
  state: SyncClientState;
  /** Current connection state */
  connectionState: ConnectionState;
  /** Last sync ID received */
  lastSyncId: SyncId;
  /** Last sync error */
  error: Error | null;
  /** Whether the client is ready */
  isReady: boolean;
  /** Whether the client is syncing */
  isSyncing: boolean;
  /** Whether the client is offline */
  isOffline: boolean;
  /** Client ID */
  clientId: string;
  /** Promise that resolves when the current readiness cycle completes */
  readyPromise: Promise<void>;
}

/**
 * Full sync context value
 */
export interface SyncContextValue extends SyncStatusContextValue {
  /** Sync client instance */
  client: SyncClient;
  /** Count of pending transactions */
  backlog: number;
}

/**
 * Use model hook result
 */
export interface UseModelResult<T> {
  /** Model data */
  data: T | null;
  /** Whether the model is loading */
  isLoading: boolean;
  /** Whether the model was found */
  isFound: boolean;
  /** Any error that occurred */
  error: Error | null;
  /** Refresh the model */
  refresh: () => Promise<void>;
}

/**
 * Use query hook options
 */
export interface UseQueryOptions<T> extends QueryOptions<T> {
  /** Skip the query (useful for conditional fetching) */
  skip?: boolean;
}

/**
 * Use query hook result
 */
export interface UseQueryResult<T> {
  /** Query results */
  data: T[];
  /** Whether the query is loading */
  isLoading: boolean;
  /** Any error that occurred */
  error: Error | null;
  /** Total count (if available) */
  totalCount?: number;
  /** Whether more results are available */
  hasMore: boolean;
  /** Refresh the query */
  refresh: () => Promise<void>;
}

/**
 * Use connection state hook result
 */
export interface UseConnectionStateResult {
  /** Current sync status */
  status: SyncClientState;
  /** Last sync ID received */
  lastSyncId: SyncId;
  /** Pending outbox count */
  backlog: number;
  /** Last sync error */
  error: Error | null;
}

/**
 * Use pending count hook result
 */
export interface UsePendingCountResult {
  /** Number of pending transactions */
  count: number;
  /** Whether there are pending transactions */
  hasPending: boolean;
}
