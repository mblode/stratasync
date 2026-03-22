import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { UseModelResult } from "../types.js";
import {
  useSyncClientInstance,
  useSyncError,
  useSyncReady,
} from "./use-sync-client.js";

/**
 * Hook to access a single model by ID
 * Suspends while bootstrapping or lazy hydration is in progress
 *
 * @param modelName - Name of the model to fetch
 * @param id - ID of the model instance
 * @returns Model instance or null if not found
 *
 * @example
 * ```tsx
 * const user = useModel<User>('User', userId);
 * if (!user) return <NotFound />;
 * return <div>{user.name}</div>;
 * ```
 */
export const useModel = <T>(
  modelName: string,
  id: string | null | undefined
): T | null => {
  const client = useSyncClientInstance();
  const isReady = useSyncReady();
  const error = useSyncError();
  const readyPromiseRef = useRef<Promise<void> | null>(null);
  const readyPromiseKeyRef = useRef({
    client,
    error,
    id,
    modelName,
  });

  const readyPromiseKey = readyPromiseKeyRef.current;
  if (
    readyPromiseKey.client !== client ||
    readyPromiseKey.error !== error ||
    readyPromiseKey.id !== id ||
    readyPromiseKey.modelName !== modelName ||
    isReady
  ) {
    readyPromiseRef.current = null;
    readyPromiseKeyRef.current = {
      client,
      error,
      id,
      modelName,
    };
  }

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!id) {
        return () => {
          /* noop */
        };
      }

      return client.onEvent((event) => {
        if (
          event.type === "modelChange" &&
          event.modelName === modelName &&
          event.modelId === id
        ) {
          onStoreChange();
        }
      });
    },
    [client, modelName, id]
  );

  const getSnapshot = useCallback(() => {
    if (!id) {
      return null;
    }
    return client.getCached<T>(modelName, id);
  }, [client, modelName, id]);

  const model = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (error) {
    throw error;
  }

  if (!id) {
    return null;
  }

  if (!isReady) {
    if (!readyPromiseRef.current) {
      // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
      readyPromiseRef.current = new Promise<void>((resolve, reject) => {
        const unsubscribe = client.onEvent((event) => {
          if (event.type === "syncError") {
            unsubscribe();
            readyPromiseRef.current = null;
            reject(event.error);
          }
          if (event.type === "stateChange" && event.state === "syncing") {
            unsubscribe();
            readyPromiseRef.current = null;
            resolve();
          }
        });
      });
    }
    throw readyPromiseRef.current;
  }

  if (model) {
    return model;
  }

  if (client.isModelMissing(modelName, id)) {
    return null;
  }

  // Suspense requires throwing a promise; discard the model result
  const suspensePromise = client.ensureModel<T>(modelName, id);
  throw suspensePromise;
};

/**
 * Non-suspense model hook with loading state
 */
export const useModelState = <T>(
  modelName: string,
  id: string | null | undefined
): UseModelResult<T> => {
  const client = useSyncClientInstance();
  const isReady = useSyncReady();
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(id));
  const [error, setError] = useState<Error | null>(null);

  const loadModel = useCallback(async () => {
    if (!id) {
      setData(null);
      setIsLoading(false);
      return;
    }

    if (!isReady) {
      setIsLoading(true);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await client.ensureModel<T>(modelName, id);
      setData(result);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError : new Error(String(loadError))
      );
    } finally {
      setIsLoading(false);
    }
  }, [client, modelName, id, isReady]);

  useEffect(() => {
    // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
    loadModel().catch(() => {
      /* noop */
    });
  }, [loadModel]);

  useEffect(() => {
    if (!id) {
      return;
    }
    const unsubscribe = client.onEvent((event) => {
      if (
        event.type === "modelChange" &&
        event.modelName === modelName &&
        event.modelId === id
      ) {
        // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
        loadModel().catch(() => {
          /* noop */
        });
      }
    });
    return unsubscribe;
  }, [client, modelName, id, loadModel]);

  return {
    data,
    error,
    isFound: data !== null,
    isLoading,
    refresh: loadModel,
  };
};
