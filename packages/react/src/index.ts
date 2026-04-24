// biome-ignore lint/performance/noBarrelFile: package entry point
export {
  SyncBacklogContext,
  SyncClientContext,
  SyncContext,
  SyncStatusContext,
} from "./context.js";
export {
  useConnectionState,
  useIsOffline,
  usePendingCount,
  useSync,
} from "./hooks/use-connection-state.js";
export {
  useModel,
  useModelState,
  useModelSuspense,
} from "./hooks/use-model.js";
export { useQuery, useQueryAll, useQueryCount } from "./hooks/use-query.js";
export {
  useSyncClient,
  useSyncClientInstance,
  useSyncError,
  useSyncReady,
  useSyncReadyPromise,
  useSyncState,
} from "./hooks/use-sync-client.js";
export type {
  DocumentKey,
  UseYjsDocumentOptions,
  UseYjsDocumentResult,
  YjsConnectionState,
  YjsSessionState,
} from "./hooks/use-yjs-document.js";
export { useYjsDocument } from "./hooks/use-yjs-document.js";
export type {
  UseYjsPresenceOptions,
  UseYjsPresenceResult,
} from "./hooks/use-yjs-presence.js";
export { useYjsPresence } from "./hooks/use-yjs-presence.js";
export { SyncProvider } from "./provider.js";
export type {
  SyncContextValue,
  UseModelResult,
  UseQueryOptions,
  UseQueryResult,
} from "./types.js";
