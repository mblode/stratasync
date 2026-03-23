// oxlint-disable no-use-before-define -- catch clause variable shadowing pattern
"use client";

import type { SyncClient } from "@stratasync/client";
import { SyncProvider as BaseSyncProvider } from "@stratasync/react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * Props for the Next.js sync provider
 */
export interface NextSyncProviderProps {
  /** Sync client instance or factory function */
  client: SyncClient | (() => SyncClient);
  /** Children to render */
  children: ReactNode;
  /** Loading component to show while client resolves (typically one render frame) */
  loading?: ReactNode;
  /** Error component to show if initialization fails */
  error?: (error: Error) => ReactNode;
  /** Callback when client is ready */
  onReady?: () => void;
  /** Callback when an error occurs */
  onError?: (error: Error) => void;
}

/**
 * Next.js App Router compatible sync provider
 *
 * Renders children immediately while the sync client starts in the background.
 * Children receive isReady=false (via context) until bootstrap completes,
 * at which point useQuery hooks begin returning data.
 *
 * @example
 * ```tsx
 * <NextSyncProvider
 *   client={syncClient}
 *   loading={<Spinner />}
 *   error={(err) => <ErrorPage message={err.message} />}
 * >
 *   {children}
 * </NextSyncProvider>
 * ```
 */
export const NextSyncProvider = ({
  client,
  children,
  loading = null,
  error: errorComponent,
  onReady,
  onError,
}: NextSyncProviderProps): ReactNode => {
  const [resolvedClient, setResolvedClient] = useState<SyncClient | null>(null);
  const [syncError, setSyncError] = useState<Error | null>(null);

  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  onReadyRef.current = onReady;
  onErrorRef.current = onError;

  // Resolve client synchronously. Don't await start().
  // BaseSyncProvider handles start() in the background via autoStart.
  useEffect(() => {
    let mounted = true;
    let ownsClient = false;
    let clientInstance: SyncClient | null = null;

    setSyncError(null);

    try {
      if (typeof client === "function") {
        clientInstance = client();
        ownsClient = true;
      } else {
        clientInstance = client;
      }

      if (mounted) {
        setResolvedClient(clientInstance);
      }
    } catch (error) {
      if (mounted) {
        const e = error instanceof Error ? error : new Error(String(error));
        setSyncError(e);
        onErrorRef.current?.(e);
      }
    }

    return () => {
      mounted = false;
      // Stop client on cleanup if we own it (factory was used)
      if (ownsClient && clientInstance) {
        // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
        clientInstance.stop().catch(() => {
          /* noop */
        });
      }
    };
  }, [client]);

  // Subscribe to client events for onReady/onError callbacks
  useEffect(() => {
    if (!resolvedClient) {
      return;
    }
    let mounted = true;

    const unsubState = resolvedClient.onStateChange((state) => {
      if (mounted && state === "syncing") {
        onReadyRef.current?.();
      }
    });

    const unsubEvents = resolvedClient.onEvent((event) => {
      if (!mounted) {
        return;
      }
      if (event.type === "syncError") {
        setSyncError(event.error);
        onErrorRef.current?.(event.error);
      }
    });

    return () => {
      mounted = false;
      unsubState();
      unsubEvents();
    };
  }, [resolvedClient]);

  if (syncError) {
    if (errorComponent) {
      return errorComponent(syncError);
    }
    throw syncError;
  }

  if (!resolvedClient) {
    return loading;
  }

  // Render children immediately. BaseSyncProvider starts the client
  // in the background (autoStart) and propagates isReady through context.
  // useQuery hooks return { data: [], isLoading: true } until ready.
  return (
    <BaseSyncProvider autoStart autoStop={false} client={resolvedClient}>
      {children}
    </BaseSyncProvider>
  );
};
