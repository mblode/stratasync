"use client";

import type { SyncClient } from "@stratasync/client";
import {
  SyncProvider as BaseSyncProvider,
  useSyncClient,
} from "@stratasync/react";
import { useEffect, useRef } from "react";
import type { MutableRefObject, ReactNode } from "react";

/**
 * Props for the Next.js sync provider
 */
export interface NextSyncProviderProps {
  /** Sync client instance */
  client: SyncClient;
  /** Children to render */
  children: ReactNode;
  /** Error component to show if initialization fails */
  error?: (error: Error) => ReactNode;
  /** Callback when client is ready */
  onReady?: () => void;
  /** Callback when an error occurs */
  onError?: (error: Error) => void;
  /** Whether the client should be stopped when the provider unmounts */
  autoStop?: boolean;
}

interface NextSyncProviderBoundaryProps {
  children: ReactNode;
  client: SyncClient;
  error?: (error: Error) => ReactNode;
  onErrorRef: MutableRefObject<((error: Error) => void) | undefined>;
  onReadyRef: MutableRefObject<(() => void) | undefined>;
}

const NextSyncProviderBoundary = ({
  children,
  client,
  error: errorComponent,
  onErrorRef,
  onReadyRef,
}: NextSyncProviderBoundaryProps): ReactNode => {
  const { error, isReady } = useSyncClient();
  const readyClientRef = useRef<SyncClient | null>(null);
  const reportedErrorRef = useRef<Error | null>(null);

  useEffect(() => {
    if (!isReady || readyClientRef.current === client) {
      return;
    }

    readyClientRef.current = client;
    onReadyRef.current?.();
  }, [client, isReady, onReadyRef]);

  useEffect(() => {
    if (!error) {
      reportedErrorRef.current = null;
      return;
    }

    if (reportedErrorRef.current === error) {
      return;
    }

    reportedErrorRef.current = error;
    onErrorRef.current?.(error);
  }, [error, onErrorRef]);

  if (error) {
    if (errorComponent) {
      return errorComponent(error);
    }
    throw error;
  }

  return children;
};

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
 *   error={(err) => <ErrorPage message={err.message} />}
 * >
 *   {children}
 * </NextSyncProvider>
 * ```
 */
export const NextSyncProvider = ({
  client,
  children,
  error: errorComponent,
  onReady,
  onError,
  autoStop = false,
}: NextSyncProviderProps): ReactNode => {
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  onReadyRef.current = onReady;
  onErrorRef.current = onError;

  return (
    <BaseSyncProvider autoStart autoStop={autoStop} client={client}>
      <NextSyncProviderBoundary
        client={client}
        error={errorComponent}
        onErrorRef={onErrorRef}
        onReadyRef={onReadyRef}
      >
        {children}
      </NextSyncProviderBoundary>
    </BaseSyncProvider>
  );
};
