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

const includesAnyModelId = <T>(
  items: T[],
  modelIds: ReadonlySet<string>
): boolean =>
  items.some((item) => {
    const { id } = item as Record<string, unknown>;
    return typeof id === "string" && modelIds.has(id);
  });

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
  matchedIds: new Set<string>(),
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
 * Whether an item belongs in this query's result set, ignoring ordering and
 * the offset/limit window.
 */
const matchesQuery = <T extends Record<string, unknown>>(
  item: T,
  options: QueryOptions<T>
): boolean => {
  if (options.where && !options.where(item)) {
    return false;
  }
  return Boolean(options.includeArchived) || !item.archivedAt;
};

/**
 * Ids in the map that satisfy the query, ignoring ordering and the
 * offset/limit window. One linear pass, no sort.
 */
const collectMatchedIds = <T extends Record<string, unknown>>(
  map: Map<string, T>,
  options: QueryOptions<T>
): Set<string> => {
  const matchedIds = new Set<string>();
  for (const [id, item] of map) {
    if (matchesQuery(item, options)) {
      matchedIds.add(id);
    }
  }
  return matchedIds;
};

/**
 * Whether any of `changedIds` can affect this query's result.
 *
 * True if an id is already in the matched set (so it may have moved, changed,
 * or been removed) or if it now satisfies the predicate (so it may have to be
 * added). An id that is in neither category cannot change the result set or
 * the relative order of anything in it.
 */
const isChangeRelevant = <T extends Record<string, unknown>>(
  map: Map<string, T>,
  matchedIds: ReadonlySet<string> | null,
  changedIds: ReadonlySet<string>,
  options: QueryOptions<T>
): boolean => {
  if (matchedIds === null) {
    return true;
  }
  for (const id of changedIds) {
    if (matchedIds.has(id)) {
      return true;
    }
    const item = map.get(id);
    if (item && matchesQuery(item, options)) {
      return true;
    }
  }
  return false;
};

/**
 * Synchronously query from a raw Map (avoids flash of empty state)
 *
 * Also returns `matchedIds`: the full set of ids that satisfy the query before
 * offset/limit is applied. Callers keep it so a later change can be tested for
 * relevance without rescanning the whole model.
 */
const querySyncFromMap = <T extends Record<string, unknown>>(
  map: Map<string, T>,
  options: QueryOptions<T> = {}
): {
  data: T[];
  totalCount: number;
  hasMore: boolean;
  matchedIds: Set<string>;
} => {
  let results: T[] = [];
  const matchedIds = new Set<string>();

  for (const [id, item] of map) {
    if (matchesQuery(item, options)) {
      results.push(item);
      matchedIds.add(id);
    }
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

  return { data: results, hasMore, matchedIds, totalCount };
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
      matchedIds: result.matchedIds,
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
    where: options.where,
  });

  const nextOptionsSnapshot = {
    includeArchived: options.includeArchived,
    limit: options.limit,
    offset: options.offset,
    orderBy: options.orderBy,
    where: options.where,
  };
  const previousOptionsSnapshot = optionsSnapshotRef.current;
  if (
    previousOptionsSnapshot.includeArchived !==
      nextOptionsSnapshot.includeArchived ||
    previousOptionsSnapshot.limit !== nextOptionsSnapshot.limit ||
    previousOptionsSnapshot.offset !== nextOptionsSnapshot.offset ||
    previousOptionsSnapshot.orderBy !== nextOptionsSnapshot.orderBy ||
    previousOptionsSnapshot.where !== nextOptionsSnapshot.where
  ) {
    optionsVersionRef.current += 1;
    optionsSnapshotRef.current = nextOptionsSnapshot;
  }
  const optionsVersion = optionsVersionRef.current;

  // Track current data for structural equality checks (avoids unnecessary re-renders)
  const dataRef = useRef<T[]>(initial.data);
  // Every id matching the query before offset/limit. Used to decide whether a
  // change is relevant at all, so an unrelated model's delta doesn't force a
  // full rescan and re-sort of the whole model. `null` means "unknown" (e.g.
  // after an async `executeQuery`), which forces the next change to rescan.
  const matchedIdsRef = useRef<Set<string> | null>(initial.matchedIds);
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
  const pendingChangedModelIdsRef = useRef<Set<string>>(new Set());
  const requestVersionRef = useRef(0);
  const handledOptionsVersionRef = useRef(optionsVersion);

  // Render-time key reset: when the client or model name changes, treat the
  // hook as a fresh mount. Invalidate in-flight requests, recompute the initial
  // state, and reset every ref + state slice so stale data/loading never leak
  // across a `modelName` change. The effect below then re-runs the query.
  const queryKeyRef = useRef({ client, modelName });
  const queryKey = queryKeyRef.current;
  if (queryKey.client !== client || queryKey.modelName !== modelName) {
    queryKeyRef.current = { client, modelName };
    requestVersionRef.current += 1;
    const nextState = computeState();
    initialRef.current = nextState;
    dataRef.current = nextState.data;
    matchedIdsRef.current = nextState.matchedIds;
    snapshotsRef.current = captureSnapshots(nextState.data);
    hasDataRef.current = nextState.data.length > 0;
    totalCountRef.current = nextState.totalCount;
    hasMoreRef.current = nextState.hasMore;
    isLoadingRef.current = nextState.isLoading;
    errorRef.current = null;
    setData(nextState.data);
    setIsLoading(nextState.isLoading);
    setError(null);
    setTotalCount(nextState.totalCount);
    setHasMore(nextState.hasMore);
  }

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
    matchedIdsRef.current = null;
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

      // `client.query` returns the windowed result, not the full matched set,
      // so rebuild it here. One linear pass now buys a free relevance check on
      // every subsequent change.
      matchedIdsRef.current = collectMatchedIds(
        client.getIdentityMap<T & Record<string, unknown>>(modelName),
        queryOptions as QueryOptions<T & Record<string, unknown>>
      );
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
        changedModelIds?: ReadonlySet<string>;
        forceDataUpdate?: boolean;
      } = {}
    ) => {
      if (optionsRef.current.skip) {
        requestVersionRef.current += 1;
        clearSkipped();
        return;
      }

      const map = client.getIdentityMap<T & Record<string, unknown>>(modelName);
      const queryOptions = buildSyncQueryOptions(optionsRef.current);

      // A change can only affect this query if the id is already in the
      // matched set or newly satisfies the predicate. Otherwise there is
      // nothing to recompute — bail before rescanning and re-sorting the
      // whole model, which is the dominant cost on large workspaces.
      if (
        refreshOptions.changedModelIds !== undefined &&
        refreshOptions.changedModelId === undefined &&
        !refreshOptions.forceDataUpdate &&
        !isChangeRelevant(
          map,
          matchedIdsRef.current,
          refreshOptions.changedModelIds,
          queryOptions
        )
      ) {
        return;
      }

      requestVersionRef.current += 1;

      const result = querySyncFromMap(map, queryOptions);
      matchedIdsRef.current = result.matchedIds;

      const forceDataUpdate =
        refreshOptions.forceDataUpdate ||
        (refreshOptions.changedModelId !== undefined &&
          includesModelId(result.data, refreshOptions.changedModelId)) ||
        (refreshOptions.changedModelIds !== undefined &&
          includesAnyModelId(result.data, refreshOptions.changedModelIds));

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
    if (!isReady || options.skip) {
      handledOptionsVersionRef.current = optionsVersion;
      return;
    }

    if (handledOptionsVersionRef.current === optionsVersion) {
      return;
    }

    handledOptionsVersionRef.current = optionsVersion;
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
    const pendingChangedModelIds = pendingChangedModelIdsRef.current;
    const unsubscribe = client.onEvent((event) => {
      // Coalesce rapid modelChange events (e.g. a delta packet with many
      // actions for the same model type) into a single refreshSync call.
      if (event.type === "modelChange" && event.modelName === modelName) {
        pendingChangedModelIds.add(event.modelId);
        if (pendingRefreshRef.current) {
          return;
        }
        pendingRefreshRef.current = true;
        queueMicrotask(() => {
          if (!active) {
            return;
          }
          pendingRefreshRef.current = false;
          const changedModelIds = new Set(pendingChangedModelIds);
          pendingChangedModelIds.clear();
          refreshSync({ changedModelIds });
        });
      }
    });

    return () => {
      active = false;
      unsubscribe();
      pendingRefreshRef.current = false;
      pendingChangedModelIds.clear();
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
