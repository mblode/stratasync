import type { QueryOptions } from "@stratasync/client";
import { useCallback, useEffect, useRef, useState } from "react";

import type { UseQueryOptions, UseQueryResult } from "../types.js";
import { useSyncClientInstance, useSyncReady } from "./use-sync-client.js";

/**
 * Lightweight snapshot of comparison-relevant fields, captured when data is
 * stored. Used to detect in-place mutations on identity-map objects that are
 * reused by reference across query results.
 */
interface ItemSnapshot {
  id: unknown;
  updatedAt: unknown;
}

const includesModelId = <T>(items: T[], modelId: string): boolean =>
  items.some((item) => (item as Record<string, unknown>).id === modelId);

const captureSnapshots = <T>(items: T[]): ItemSnapshot[] =>
  items.map((item) => {
    const record = item as Record<string, unknown>;
    return { id: record.id, updatedAt: record.updatedAt };
  });

/**
 * Compares new query result items against previously-captured snapshots.
 * Returns true if every item matches its snapshot by id + updatedAt.
 *
 * Unlike a direct reference comparison, this detects in-place mutations
 * because the snapshot stores *copied* values from the time data was last
 * committed to React state.
 */
const isQueryResultEqual = <T>(
  snapshots: ItemSnapshot[],
  next: T[]
): boolean => {
  if (snapshots.length !== next.length) {
    return false;
  }
  for (let i = 0; i < snapshots.length; i += 1) {
    const s = snapshots[i];
    const n = next[i] as Record<string, unknown>;
    if (s?.id !== n.id) {
      return false;
    }
    if (s?.updatedAt !== n.updatedAt) {
      return false;
    }
  }
  return true;
};

/**
 * Default empty state for a query that hasn't loaded data yet.
 */
const emptyQueryState = <T>(isLoading: boolean) => ({
  data: [] as T[],
  hasMore: false,
  isLoading,
  totalCount: undefined as number | undefined,
});

/**
 * Cast UseQueryOptions<T> to QueryOptions compatible with the identity map's
 * `T & Record<string, unknown>` shape.
 */
const buildSyncQueryOptions = <T>(
  opts: UseQueryOptions<T>
): QueryOptions<T & Record<string, unknown>> => ({
  includeArchived: opts.includeArchived,
  limit: opts.limit,
  offset: opts.offset,
  orderBy: opts.orderBy as
    | ((
        a: T & Record<string, unknown>,
        b: T & Record<string, unknown>
      ) => number)
    | undefined,
  where: opts.where as
    | ((item: T & Record<string, unknown>) => boolean)
    | undefined,
});

/**
 * Synchronously query from a raw Map (avoids flash of empty state)
 */
const querySyncFromMap = <T extends Record<string, unknown>>(
  map: Map<string, T>,
  options: QueryOptions<T> = {}
): { data: T[]; totalCount: number; hasMore: boolean } => {
  let results = [...map.values()];

  if (options.where) {
    results = results.filter(options.where);
  }

  if (!options.includeArchived) {
    results = results.filter((item) => !item.archivedAt);
  }

  const totalCount = results.length;

  if (options.orderBy) {
    results = results.toSorted(options.orderBy);
  }

  if (options.offset && options.offset > 0) {
    results = results.slice(options.offset);
  }

  let hasMore = false;
  if (options.limit && options.limit > 0) {
    hasMore = results.length > options.limit;
    results = results.slice(0, options.limit);
  }

  return { data: results, hasMore, totalCount };
};

/**
 * Hook to query models with filtering, sorting, and pagination
 *
 * @param modelName - Name of the model to query
 * @param options - Query options including filters, sorting, and pagination
 * @returns UseQueryResult with data array, loading state, and metadata
 *
 * @example
 * ```tsx
 * function TaskList({ projectId }: { projectId: string }) {
 *   const { data: tasks, isLoading, hasMore } = useQuery<Task>('Task', {
 *     where: (task) => task.projectId === projectId,
 *     orderBy: (a, b) => a.createdAt - b.createdAt,
 *     limit: 20,
 *   });
 *
 *   if (isLoading) return <Spinner />;
 *
 *   return (
 *     <ul>
 *       {tasks.map((task) => (
 *         <li key={task.id}>{task.title}</li>
 *       ))}
 *     </ul>
 *   );
 * }
 * ```
 */
export const useQuery = <T>(
  modelName: string,
  options: UseQueryOptions<T> = {}
): UseQueryResult<T> => {
  const client = useSyncClientInstance();
  const isReady = useSyncReady();

  // Compute initial state from identity map (only runs on mount via lazy useState)
  const computeState = () => {
    if (options.skip) {
      return emptyQueryState<T>(false);
    }

    if (!isReady) {
      return emptyQueryState<T>(true);
    }

    const map = client.getIdentityMap<T & Record<string, unknown>>(modelName);
    if (map.size === 0) {
      return emptyQueryState<T>(true);
    }

    const result = querySyncFromMap(map, buildSyncQueryOptions(options));

    return {
      data: result.data as T[],
      hasMore: result.hasMore,
      isLoading: false,
      totalCount: result.totalCount as number | undefined,
    };
  };

  // Lazy initializers: only run on mount, preventing MobX tracking on re-renders
  const initialRef = useRef<ReturnType<typeof computeState> | null>(null);
  if (initialRef.current === null) {
    initialRef.current = computeState();
  }
  const initial = initialRef.current;

  const [data, setData] = useState<T[]>(initial.data);
  const [isLoading, setIsLoading] = useState(initial.isLoading);
  const [error, setError] = useState<Error | null>(null);
  const [totalCount, setTotalCount] = useState<number | undefined>(
    initial.totalCount
  );
  const [hasMore, setHasMore] = useState(initial.hasMore);

  // Use ref to track options to avoid infinite loops
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const optionsVersionRef = useRef(0);
  const optionsSnapshotRef = useRef({
    includeArchived: options.includeArchived,
    limit: options.limit,
    offset: options.offset,
    orderBy: options.orderBy,
    skip: options.skip,
    where: options.where,
  });

  const nextOptionsSnapshot = {
    includeArchived: options.includeArchived,
    limit: options.limit,
    offset: options.offset,
    orderBy: options.orderBy,
    skip: options.skip,
    where: options.where,
  };
  const previousOptionsSnapshot = optionsSnapshotRef.current;
  if (
    previousOptionsSnapshot.includeArchived !==
      nextOptionsSnapshot.includeArchived ||
    previousOptionsSnapshot.limit !== nextOptionsSnapshot.limit ||
    previousOptionsSnapshot.offset !== nextOptionsSnapshot.offset ||
    previousOptionsSnapshot.orderBy !== nextOptionsSnapshot.orderBy ||
    previousOptionsSnapshot.skip !== nextOptionsSnapshot.skip ||
    previousOptionsSnapshot.where !== nextOptionsSnapshot.where
  ) {
    optionsVersionRef.current += 1;
    optionsSnapshotRef.current = nextOptionsSnapshot;
  }
  const optionsVersion = optionsVersionRef.current;

  // Track current data for structural equality checks (avoids unnecessary re-renders)
  const dataRef = useRef<T[]>(initial.data);
  // Snapshot of id+updatedAt per item. Detects in-place identity-map mutations.
  const snapshotsRef = useRef<ItemSnapshot[]>(captureSnapshots(initial.data));
  // Track if we have data to avoid setting loading state when refreshing cached data
  const hasDataRef = useRef(initial.data.length > 0);
  // Ref mirrors for metadata state: only call setters when values actually change
  const totalCountRef = useRef<number | undefined>(initial.totalCount);
  const hasMoreRef = useRef(initial.hasMore);
  const isLoadingRef = useRef(initial.isLoading);
  const errorRef = useRef<Error | null>(null);
  // Microtask debounce flag. Coalesces rapid modelChange events into one refresh.
  const pendingRefreshRef = useRef(false);
  const requestVersionRef = useRef(0);

  /**
   * Apply a query result to React state. Only calls setters when values
   * actually changed, preventing unnecessary re-renders.
   */
  const applyResult = useCallback(
    (
      resultData: T[],
      resultTotalCount: number | undefined,
      resultHasMore: boolean,
      applyOptions: { forceDataUpdate?: boolean } = {}
    ) => {
      if (
        applyOptions.forceDataUpdate ||
        !isQueryResultEqual(snapshotsRef.current, resultData)
      ) {
        snapshotsRef.current = captureSnapshots(resultData);
        dataRef.current = resultData;
        setData(resultData);
      }
      if (resultTotalCount !== totalCountRef.current) {
        totalCountRef.current = resultTotalCount;
        setTotalCount(resultTotalCount);
      }
      if (resultHasMore !== hasMoreRef.current) {
        hasMoreRef.current = resultHasMore;
        setHasMore(resultHasMore);
      }
      hasDataRef.current = resultData.length > 0;
      if (isLoadingRef.current !== false) {
        isLoadingRef.current = false;
        setIsLoading(false);
      }
      if (errorRef.current !== null) {
        errorRef.current = null;
        setError(null);
      }
    },
    []
  );

  /** Clear data and stop loading (used when query is skipped). */
  const clearSkipped = useCallback(() => {
    if (dataRef.current.length > 0) {
      dataRef.current = [];
      snapshotsRef.current = [];
      setData([]);
    }
    hasDataRef.current = false;
    if (totalCountRef.current !== undefined) {
      totalCountRef.current = undefined;
      setTotalCount(undefined);
    }
    if (hasMoreRef.current !== false) {
      hasMoreRef.current = false;
      setHasMore(false);
    }
    if (errorRef.current !== null) {
      errorRef.current = null;
      setError(null);
    }
    if (isLoadingRef.current !== false) {
      isLoadingRef.current = false;
      setIsLoading(false);
    }
  }, []);

  const executeQuery = useCallback(async () => {
    if (optionsRef.current.skip) {
      requestVersionRef.current += 1;
      clearSkipped();
      return;
    }

    requestVersionRef.current += 1;
    const requestVersion = requestVersionRef.current;

    // Only show loading if we don't already have cached data
    // This prevents the flash of empty state when refreshing
    if (!hasDataRef.current) {
      isLoadingRef.current = true;
      setIsLoading(true);
    }
    if (errorRef.current !== null) {
      errorRef.current = null;
      setError(null);
    }

    try {
      const queryOptions: QueryOptions<T> = {
        includeArchived: optionsRef.current.includeArchived,
        limit: optionsRef.current.limit,
        offset: optionsRef.current.offset,
        orderBy: optionsRef.current.orderBy,
        where: optionsRef.current.where,
      };

      const result = await client.query<T>(modelName, queryOptions);
      if (requestVersion !== requestVersionRef.current) {
        return;
      }

      applyResult(result.data, result.totalCount, result.hasMore, {
        forceDataUpdate: true,
      });
    } catch (queryError) {
      if (requestVersion !== requestVersionRef.current) {
        return;
      }
      const newError =
        queryError instanceof Error
          ? queryError
          : new Error(String(queryError));
      errorRef.current = newError;
      setError(newError);
      // Preserve stale data on refresh errors to avoid UI flash.
      hasDataRef.current = dataRef.current.length > 0;
      if (isLoadingRef.current !== false) {
        isLoadingRef.current = false;
        setIsLoading(false);
      }
    }
  }, [client, modelName, applyResult, clearSkipped]);

  // Synchronous refresh: reads identity map and updates React state immediately
  const refreshSync = useCallback(
    (
      refreshOptions: {
        changedModelId?: string;
        forceDataUpdate?: boolean;
      } = {}
    ) => {
      if (optionsRef.current.skip) {
        clearSkipped();
        return;
      }

      const map = client.getIdentityMap<T & Record<string, unknown>>(modelName);
      const result = querySyncFromMap(
        map,
        buildSyncQueryOptions(optionsRef.current)
      );

      const forceDataUpdate =
        refreshOptions.forceDataUpdate ||
        (refreshOptions.changedModelId !== undefined &&
          includesModelId(result.data, refreshOptions.changedModelId));

      applyResult(result.data as T[], result.totalCount, result.hasMore, {
        forceDataUpdate,
      });
    },
    [client, modelName, applyResult, clearSkipped]
  );

  useEffect(() => {
    if (isReady && !options.skip) {
      executeQuery();
    } else if (options.skip) {
      requestVersionRef.current += 1;
      clearSkipped();
    }
  }, [isReady, options.skip, executeQuery, clearSkipped]);

  useEffect(() => {
    if (optionsVersion === 0 || !isReady || options.skip) {
      return;
    }

    refreshSync();
  }, [optionsVersion, isReady, options.skip, refreshSync]);

  useEffect(
    () => () => {
      requestVersionRef.current += 1;
    },
    []
  );

  useEffect(() => {
    if (!isReady || options.skip) {
      return;
    }

    let active = true;
    const unsubscribe = client.onEvent((event) => {
      // Coalesce rapid modelChange events (e.g. a delta packet with many
      // actions for the same model type) into a single refreshSync call.
      if (
        event.type === "modelChange" &&
        event.modelName === modelName &&
        !pendingRefreshRef.current
      ) {
        pendingRefreshRef.current = true;
        queueMicrotask(() => {
          if (!active) {
            return;
          }
          pendingRefreshRef.current = false;
          refreshSync({ changedModelId: event.modelId });
        });
      }
    });

    return () => {
      active = false;
      unsubscribe();
      pendingRefreshRef.current = false;
    };
  }, [client, modelName, isReady, options.skip, refreshSync]);

  return {
    data,
    error,
    hasMore,
    isLoading,
    refresh: executeQuery,
    totalCount,
  };
};

/**
 * Hook to query all models of a type
 */
export const useQueryAll = <T>(
  modelName: string,
  options: Omit<UseQueryOptions<T>, "limit" | "offset"> = {}
): UseQueryResult<T> => useQuery<T>(modelName, options);

export const useQueryCount = <T>(
  modelName: string,
  where?: (item: T) => boolean
): {
  count: number;
  isLoading: boolean;
  error: Error | null;
} => {
  const { data, error, isLoading, totalCount } = useQueryAll<T>(modelName, {
    where,
  });

  return {
    count: totalCount ?? data.length,
    error,
    isLoading,
  };
};
