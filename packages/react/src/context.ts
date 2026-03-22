import { createContext } from "react";
import type { Context } from "react";

import type { SyncContextValue, SyncStatusContextValue } from "./types.js";

/**
 * React context for the sync client
 */
export const SyncContext = createContext<SyncContextValue | null>(null);

/**
 * Display name for React DevTools
 */
SyncContext.displayName = "SyncContext";

/**
 * React context for the sync client instance only.
 * This stays stable across backlog/status updates.
 */
export const SyncClientContext: Context<SyncContextValue["client"] | null> =
  createContext<SyncContextValue["client"] | null>(null);
SyncClientContext.displayName = "SyncClientContext";

/**
 * React context for sync lifecycle/status state.
 * Backlog is split out to avoid frequent subscription churn.
 */
export const SyncStatusContext = createContext<SyncStatusContextValue | null>(
  null
);
SyncStatusContext.displayName = "SyncStatusContext";

/**
 * React context for pending backlog count.
 */
export const SyncBacklogContext = createContext<number>(0);
SyncBacklogContext.displayName = "SyncBacklogContext";
