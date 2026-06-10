import { createContext } from "react";
import type { Context } from "react";

import type { SyncContextValue, SyncStatusContextValue } from "./types.js";

/**
 * React context for the sync client instance only.
 * This stays stable across backlog/status updates.
 *
 * The sync surface is split into three independent contexts (client / status /
 * backlog) so a consumer that only needs the client doesn't re-render on
 * backlog churn. `useSync` composes them; there is intentionally no combined
 * context.
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
