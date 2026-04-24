import type { SyncClient } from "@stratasync/client";
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
  useSyncReadyPromise,
} from "./use-sync-client.js";

interface ModelSnapshot<T> {
  model: T | null;
  version: number;
}

interface ModelLoadKey {
  client: SyncClient;
  modelName: string;
  id: string;
}

const isSameModelLoadKey = (a: ModelLoadKey | null, b: ModelLoadKey): boolean =>
  a?.client === b.client && a.modelName === b.modelName && a.id === b.id;

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
  const readyPromise = useSyncReadyPromise();
  const error = useSyncError();
  const snapshotCacheRef = useRef<ModelSnapshot<T> | null>(null);
  const snapshotKeyRef = useRef({
    client,
    id,
    modelName,
  });
  const snapshotVersionRef = useRef(0);

  const snapshotKey = snapshotKeyRef.current;
  if (
    snapshotKey.client !== client ||
    snapshotKey.id !== id ||
    snapshotKey.modelName !== modelName
  ) {
    snapshotCacheRef.current = null;
    snapshotVersionRef.current = 0;
    snapshotKeyRef.current = {
      client,
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
          snapshotVersionRef.current += 1;
          onStoreChange();
        }
      });
    },
    [client, modelName, id]
  );

  const getSnapshot = useCallback(() => {
    const model = id ? client.getCached<T>(modelName, id) : null;
    const version = snapshotVersionRef.current;
    const cachedSnapshot = snapshotCacheRef.current;

    if (
      cachedSnapshot &&
      cachedSnapshot.model === model &&
      cachedSnapshot.version === version
    ) {
      return cachedSnapshot;
    }

    const nextSnapshot = {
      model,
      version,
    };
    snapshotCacheRef.current = nextSnapshot;
    return nextSnapshot;
  }, [client, modelName, id]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { model } = snapshot;

  if (error) {
    throw error;
  }

  if (!id) {
    return null;
  }

  if (!isReady) {
    throw readyPromise;
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
  const clientRef = useRef(client);
  const modelNameRef = useRef(modelName);
  const idRef = useRef(id);
  const isReadyRef = useRef(isReady);
  const dataKeyRef = useRef<ModelLoadKey | null>(null);
  const requestVersionRef = useRef(0);

  clientRef.current = client;
  modelNameRef.current = modelName;
  idRef.current = id;
  isReadyRef.current = isReady;

  const loadModel = useCallback(async () => {
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;

    if (!idRef.current) {
      dataKeyRef.current = null;
      setData(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    const loadKey = {
      client: clientRef.current,
      id: idRef.current,
      modelName: modelNameRef.current,
    };
    if (!isSameModelLoadKey(dataKeyRef.current, loadKey)) {
      setData(null);
    }

    if (!isReadyRef.current) {
      setIsLoading(true);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await loadKey.client.ensureModel<T>(
        loadKey.modelName,
        loadKey.id
      );
      if (requestVersion !== requestVersionRef.current) {
        return;
      }
      dataKeyRef.current = loadKey;
      setData(result);
    } catch (loadError) {
      if (requestVersion !== requestVersionRef.current) {
        return;
      }
      setError(
        loadError instanceof Error ? loadError : new Error(String(loadError))
      );
    } finally {
      if (requestVersion === requestVersionRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
    loadModel().catch(() => {
      /* noop */
    });
  }, [client, modelName, id, isReady, loadModel]);

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

  useEffect(
    () => () => {
      requestVersionRef.current += 1;
    },
    []
  );

  return {
    data,
    error,
    isFound: data !== null,
    isLoading,
    refresh: loadModel,
  };
};

export const useModelSuspense = useModel;
