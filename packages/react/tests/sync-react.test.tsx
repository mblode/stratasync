import type {
  QueryOptions,
  QueryResult,
  SyncClient,
  SyncClientEvent,
} from "@stratasync/client";
import type { ConnectionState, SyncClientState } from "@stratasync/core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Suspense, useCallback } from "react";

import {
  SyncProvider,
  useConnectionState,
  useIsOffline,
  useModel,
  useModelState,
  useModelSuspense,
  usePendingCount,
  useQuery,
  useQueryCount,
  useSync,
  useSyncClient,
  useSyncClientInstance,
  useSyncReady,
  useSyncState,
} from "../src";

type ModelChangeAction =
  | "insert"
  | "update"
  | "delete"
  | "archive"
  | "unarchive";

interface TestClientOptions {
  state?: SyncClientState;
  connectionState?: ConnectionState;
  lastSyncId?: number;
  lastError?: Error | null;
  clientId?: string;
  pendingCount?: number;
}

interface TestClient extends SyncClient {
  emitEvent: (event: SyncClientEvent) => void;
  emitStateChange: (state: SyncClientState) => void;
  emitConnectionChange: (state: ConnectionState) => void;
  emitSyncComplete: (lastSyncId: number) => void;
  emitSyncError: (error: Error) => void;
  emitOutboxChange: (pendingCount: number) => void;
  emitModelChange: (
    modelName: string,
    modelId: string,
    action: ModelChangeAction
  ) => void;
  setQueryResult: (result: QueryResult<unknown>) => void;
  setEnsureModelResult: (result: unknown) => void;
}

const createTestClient = (options: TestClientOptions = {}): TestClient => {
  const eventListeners = new Set<(event: SyncClientEvent) => void>();
  const stateListeners = new Set<(state: SyncClientState) => void>();
  const connectionListeners = new Set<(state: ConnectionState) => void>();

  let stateValue = options.state ?? "disconnected";
  let connectionValue = options.connectionState ?? "disconnected";
  let lastSyncIdValue = options.lastSyncId ?? 0;
  let lastErrorValue = options.lastError ?? null;
  let pendingCountValue = options.pendingCount ?? 0;
  let queryResultValue: QueryResult<unknown> = {
    data: [],
    hasMore: false,
  };
  let ensureModelValue: unknown = null;

  const emitEvent = (event: SyncClientEvent): void => {
    for (const listener of eventListeners) {
      listener(event);
    }
  };

  const query = vi.fn(
    <T,>(
      _modelName: string,
      _options?: QueryOptions<T>
    ): Promise<QueryResult<T>> => queryResultValue as QueryResult<T>
  );

  const ensureModel = vi.fn(
    <T,>(_modelName: string, _id: string): Promise<T | null> =>
      ensureModelValue as T | null
  );

  const client: TestClient = {
    archive: vi.fn(async () => {
      /* noop */
    }),
    canRedo: vi.fn(() => false),
    canUndo: vi.fn(() => false),
    clearAll: vi.fn(async () => {
      /* noop */
    }),
    clientId: options.clientId ?? "client-1",
    get connectionState() {
      return connectionValue;
    },
    set connectionState(value) {
      connectionValue = value;
    },
    create: vi.fn(
      <T extends Record<string, unknown>>(
        _modelName: string,
        data: T
      ): Promise<T> => data
    ),
    delete: vi.fn(async () => {
      /* noop */
    }),
    emitConnectionChange: (nextState) => {
      connectionValue = nextState;
      for (const listener of connectionListeners) {
        listener(nextState);
      }
      emitEvent({ state: nextState, type: "connectionChange" });
    },
    emitEvent,
    emitModelChange: (modelName, modelId, action) => {
      emitEvent({ action, modelId, modelName, type: "modelChange" });
    },
    emitOutboxChange: (nextCount) => {
      pendingCountValue = nextCount;
      emitEvent({ pendingCount: nextCount, type: "outboxChange" });
    },
    emitStateChange: (nextState) => {
      stateValue = nextState;
      for (const listener of stateListeners) {
        listener(nextState);
      }
      emitEvent({ state: nextState, type: "stateChange" });
    },
    emitSyncComplete: (nextSyncId) => {
      lastSyncIdValue = nextSyncId;
      emitEvent({ lastSyncId: nextSyncId, type: "syncComplete" });
    },
    emitSyncError: (error) => {
      lastErrorValue = error;
      emitEvent({ error, type: "syncError" });
    },
    ensureModel,
    get: vi.fn(() => null),
    getAll: vi.fn(() => []),
    getCached: vi.fn(() => null),
    getIdentityMap: vi.fn(() => {
      const map = new Map<string, unknown>();
      for (const item of queryResultValue.data) {
        const record = item as Record<string, unknown>;
        if (record.id) {
          map.set(record.id as string, record);
        }
      }
      return map;
    }),
    getPendingCount: vi.fn(() => pendingCountValue),
    isModelMissing: vi.fn(() => false),
    get lastError() {
      return lastErrorValue;
    },
    set lastError(value) {
      lastErrorValue = value;
    },
    get lastSyncId() {
      return lastSyncIdValue;
    },
    set lastSyncId(value) {
      lastSyncIdValue = value;
    },
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    onConnectionStateChange: (callback) => {
      connectionListeners.add(callback);
      return () => {
        connectionListeners.delete(callback);
      };
    },
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    onEvent: (callback) => {
      eventListeners.add(callback);
      return () => {
        eventListeners.delete(callback);
      };
    },
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    onStateChange: (callback) => {
      stateListeners.add(callback);
      return () => {
        stateListeners.delete(callback);
      };
    },
    query,
    redo: vi.fn(async () => {
      /* noop */
    }),
    runAsUndoGroup: vi.fn(
      async (operation: () => Promise<unknown> | unknown): Promise<unknown> =>
        await operation()
    ),
    setEnsureModelResult: (result) => {
      ensureModelValue = result;
    },
    setQueryResult: (result) => {
      queryResultValue = result;
    },
    start: vi.fn(async () => {
      /* noop */
    }),
    get state() {
      return stateValue;
    },
    set state(value) {
      stateValue = value;
    },
    stop: vi.fn(async () => {
      /* noop */
    }),
    syncNow: vi.fn(async () => {
      /* noop */
    }),
    unarchive: vi.fn(async () => {
      /* noop */
    }),
    undo: vi.fn(async () => {
      /* noop */
    }),
    update: vi.fn(
      <T extends Record<string, unknown>>(
        _modelName: string,
        _id: string,
        changes: Partial<T>
      ): Promise<T> =>
        ({
          ...changes,
        }) as T
    ),
  };

  return client;
};

const booleanText = (value: boolean): string => (value ? "true" : "false");

afterEach(() => {
  cleanup();
});

const createDeferred = <T,>() => {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- resolve/reject are reassigned inside Promise constructor
  let resolve: (value: T | PromiseLike<T>) => void = () => {
    /* noop */
  };
  // eslint-disable-next-line unicorn/consistent-function-scoping
  let reject: (reason?: unknown) => void = () => {
    /* noop */
  };

  // oxlint-disable-next-line avoid-new, param-names -- wrapping callback API in promise; outer vars shadow resolve/reject
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
};

const StatusProbe = () => {
  const context = useSyncClient();
  const { status, lastSyncId, backlog, error } = useConnectionState();
  const { count, hasPending } = usePendingCount();
  const ready = useSyncReady();
  const syncState = useSyncState();
  const offline = useIsOffline();
  const clientInstance = useSyncClientInstance();

  return (
    <div>
      <div data-testid="state">{context.state}</div>
      <div data-testid="status">{status}</div>
      <div data-testid="syncState">{syncState}</div>
      <div data-testid="lastSyncId">{String(lastSyncId)}</div>
      <div data-testid="backlog">{String(backlog)}</div>
      <div data-testid="pendingCount">{String(count)}</div>
      <div data-testid="hasPending">{booleanText(hasPending)}</div>
      <div data-testid="error">{error?.message ?? ""}</div>
      <div data-testid="isReady">{booleanText(ready)}</div>
      <div data-testid="isSyncing">{booleanText(context.isSyncing)}</div>
      <div data-testid="isOffline">{booleanText(offline)}</div>
      <div data-testid="clientMatch">
        {booleanText(clientInstance === context.client)}
      </div>
    </div>
  );
};

const SYNC_PROVIDER_ERROR_RE = /SyncProvider/;

const SyncProbe = () => {
  const { sync, isSyncing } = useSync();

  const handleSync = useCallback(() => {
    sync().catch(() => {
      /* noop */
    });
  }, [sync]);

  return (
    <div>
      <button onClick={handleSync} type="button">
        Sync
      </button>
      <div data-testid="syncing">{booleanText(isSyncing)}</div>
    </div>
  );
};

interface Task {
  id: string;
  title: string;
}

const QueryProbe = ({ skip = false }: { skip?: boolean }) => {
  const { data, isLoading, hasMore, totalCount, error, refresh } =
    useQuery<Task>("Task", {
      limit: 10,
      skip,
    });

  const handleRefresh = useCallback(() => {
    refresh().catch(() => {
      /* noop */
    });
  }, [refresh]);

  return (
    <div>
      <div data-testid="loading">{booleanText(isLoading)}</div>
      <div data-testid="count">{String(data.length)}</div>
      <div data-testid="hasMore">{booleanText(hasMore)}</div>
      <div data-testid="totalCount">{String(totalCount ?? 0)}</div>
      <div data-testid="firstTitle">{data[0]?.title ?? ""}</div>
      <div data-testid="error">{error?.message ?? ""}</div>
      <button data-testid="refresh" onClick={handleRefresh} type="button">
        refresh
      </button>
    </div>
  );
};

const ModelProbe = ({ id }: { id: string | null }) => {
  const { data, isLoading, isFound } = useModelState<Task>("Task", id);

  return (
    <div>
      <div data-testid="loading">{booleanText(isLoading)}</div>
      <div data-testid="found">{booleanText(isFound)}</div>
      <div data-testid="title">{data?.title ?? ""}</div>
    </div>
  );
};

const SuspenseModelProbe = ({ id }: { id: string }) => {
  const task = useModel<Task>("Task", id);

  return <div data-testid="suspenseTitle">{task?.title ?? ""}</div>;
};

const QueryFilterProbe = ({ type }: { type: string }) => {
  const { data } = useQuery<Task & { type: string }>("Task", {
    where: (task) => task.type === type,
  });

  return <div data-testid="filteredTitle">{data[0]?.title ?? ""}</div>;
};

const ClientReadyProbe = ({ snapshots }: { snapshots: string[] }) => {
  const client = useSyncClientInstance();
  const ready = useSyncReady();

  snapshots.push(`${client.clientId}:${booleanText(ready)}`);

  return <div data-testid="clientReady">{booleanText(ready)}</div>;
};

const QueryCountProbe = () => {
  const { count, isLoading } = useQueryCount<Task>("Task");

  return (
    <div>
      <div data-testid="queryCount">{String(count)}</div>
      <div data-testid="queryCountLoading">{booleanText(isLoading)}</div>
    </div>
  );
};

describe("sync-react bindings", () => {
  it("throws when useSyncClient is outside the provider", () => {
    const renderOutside = () => render(<StatusProbe />);
    expect(renderOutside).toThrowError(SYNC_PROVIDER_ERROR_RE);
  });

  it("surfaces sync state and updates derived flags from events", async () => {
    const client = createTestClient({
      connectionState: "disconnected",
      lastSyncId: 12,
      pendingCount: 3,
      state: "bootstrapping",
    });

    render(
      <SyncProvider client={client}>
        <StatusProbe />
      </SyncProvider>
    );

    await waitFor(() => {
      expect(client.start).toHaveBeenCalledOnce();
    });

    await waitFor(() => {
      expect(screen.getByTestId("backlog").textContent).toBe("3");
    });

    expect(screen.getByTestId("state").textContent).toBe("bootstrapping");
    expect(screen.getByTestId("status").textContent).toBe("bootstrapping");
    expect(screen.getByTestId("isReady").textContent).toBe("false");
    expect(screen.getByTestId("isSyncing").textContent).toBe("true");
    expect(screen.getByTestId("isOffline").textContent).toBe("true");
    expect(screen.getByTestId("pendingCount").textContent).toBe("3");
    expect(screen.getByTestId("hasPending").textContent).toBe("true");
    expect(screen.getByTestId("clientMatch").textContent).toBe("true");

    const syncError = new Error("offline");
    act(() => {
      client.emitSyncError(syncError);
    });

    expect(screen.getByTestId("error").textContent).toBe("offline");

    act(() => {
      client.emitStateChange("syncing");
      client.emitConnectionChange("connected");
      client.emitOutboxChange(0);
      client.emitSyncComplete(99);
    });

    await waitFor(() => {
      expect(screen.getByTestId("lastSyncId").textContent).toBe("99");
    });

    expect(screen.getByTestId("isReady").textContent).toBe("true");
    expect(screen.getByTestId("isSyncing").textContent).toBe("true");
    expect(screen.getByTestId("isOffline").textContent).toBe("false");
    expect(screen.getByTestId("error").textContent).toBe("");
    expect(screen.getByTestId("pendingCount").textContent).toBe("0");
  });

  it("updates lastSyncId when syncComplete fires on its own", async () => {
    const client = createTestClient({
      connectionState: "connected",
      lastSyncId: 1,
      state: "syncing",
    });

    render(
      <SyncProvider client={client}>
        <StatusProbe />
      </SyncProvider>
    );

    expect(screen.getByTestId("lastSyncId").textContent).toBe("1");

    act(() => {
      client.emitSyncComplete(2);
    });

    await waitFor(() => {
      expect(screen.getByTestId("lastSyncId").textContent).toBe("2");
    });
  });

  it("stops the client when the provider unmounts", async () => {
    const client = createTestClient({ state: "syncing" });

    const { unmount } = render(
      <SyncProvider client={client}>
        <div />
      </SyncProvider>
    );

    await waitFor(() => {
      expect(client.start).toHaveBeenCalledOnce();
    });

    unmount();

    await waitFor(() => {
      expect(client.stop).toHaveBeenCalledOnce();
    });
  });

  it("uses the replacement client's status during the first rerender", async () => {
    const firstClient = createTestClient({
      clientId: "first-client",
      state: "syncing",
    });
    const secondClient = createTestClient({
      clientId: "second-client",
      state: "bootstrapping",
    });
    const snapshots: string[] = [];

    const { rerender } = render(
      <SyncProvider client={firstClient}>
        <ClientReadyProbe snapshots={snapshots} />
      </SyncProvider>
    );

    await waitFor(() => {
      expect(firstClient.start).toHaveBeenCalledOnce();
    });

    rerender(
      <SyncProvider client={secondClient}>
        <ClientReadyProbe snapshots={snapshots} />
      </SyncProvider>
    );

    await waitFor(() => {
      expect(secondClient.start).toHaveBeenCalledOnce();
    });

    expect(snapshots).toContain("first-client:true");
    expect(snapshots).toContain("second-client:false");
    expect(snapshots).not.toContain("second-client:true");
  });

  it("debounces sync requests while a sync is in flight", async () => {
    const client = createTestClient({ state: "syncing" });
    let resolveSync: (() => void) | null = null;

    client.syncNow = vi.fn(
      () =>
        // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
        new Promise<void>((resolve) => {
          resolveSync = resolve;
        })
    );

    render(
      <SyncProvider client={client}>
        <SyncProbe />
      </SyncProvider>
    );

    const button = screen.getByRole("button", { name: "Sync" });
    fireEvent.click(button);

    expect(client.syncNow).toHaveBeenCalledOnce();
    expect(screen.getByTestId("syncing").textContent).toBe("true");

    fireEvent.click(button);
    expect(client.syncNow).toHaveBeenCalledOnce();

    act(() => {
      resolveSync?.();
    });

    await waitFor(() => {
      expect(screen.getByTestId("syncing").textContent).toBe("false");
    });
  });

  it("skips queries when configured and re-runs on model changes", async () => {
    const client = createTestClient({ state: "syncing" });

    const { rerender } = render(
      <SyncProvider client={client}>
        <QueryProbe skip />
      </SyncProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    expect(client.query).not.toHaveBeenCalled();

    client.setQueryResult({
      data: [{ id: "task-1", title: "First" }],
      hasMore: true,
      totalCount: 2,
    });

    rerender(
      <SyncProvider client={client}>
        <QueryProbe />
      </SyncProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("count").textContent).toBe("1");
    });

    expect(screen.getByTestId("hasMore").textContent).toBe("true");
    expect(screen.getByTestId("totalCount").textContent).toBe("2");
    expect(screen.getByTestId("firstTitle").textContent).toBe("First");

    client.setQueryResult({
      data: [
        { id: "task-1", title: "First" },
        { id: "task-2", title: "Second" },
      ],
      hasMore: false,
      totalCount: 2,
    });

    fireEvent.click(screen.getByTestId("refresh"));

    await waitFor(() => {
      expect(screen.getByTestId("count").textContent).toBe("2");
    });

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("hasMore").textContent).toBe("false");
  });

  it("updates query results when filter options change without re-querying", async () => {
    const client = createTestClient({ state: "syncing" });
    const tasks = [
      { id: "task-a", title: "A", type: "a" },
      { id: "task-b", title: "B", type: "b" },
    ];

    client.query = vi.fn(
      (_modelName, options?: QueryOptions<(typeof tasks)[number]>) => {
        const data = tasks.filter((task) =>
          options?.where ? options.where(task) : true
        );

        return Promise.resolve({
          data,
          hasMore: false,
          totalCount: data.length,
        });
      }
    ) as typeof client.query;

    client.getIdentityMap = vi.fn(() => {
      const map = new Map<string, (typeof tasks)[number]>();
      for (const task of tasks) {
        map.set(task.id, task);
      }
      return map;
    }) as typeof client.getIdentityMap;

    const { rerender } = render(
      <SyncProvider client={client}>
        <QueryFilterProbe type="a" />
      </SyncProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("filteredTitle").textContent).toBe("A");
    });

    rerender(
      <SyncProvider client={client}>
        <QueryFilterProbe type="b" />
      </SyncProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("filteredTitle").textContent).toBe("B");
    });

    expect(client.query).toHaveBeenCalledOnce();
  });

  it("does not run a queued query refresh after unmount", async () => {
    const client = createTestClient({ state: "syncing" });
    const getIdentityMap = vi.fn(
      () =>
        new Map<string, Task>([["task-1", { id: "task-1", title: "Initial" }]])
    );

    client.getIdentityMap = getIdentityMap as typeof client.getIdentityMap;
    client.setQueryResult({
      data: [{ id: "task-1", title: "Initial" }],
      hasMore: false,
      totalCount: 1,
    });

    const { unmount } = render(
      <SyncProvider client={client}>
        <QueryProbe />
      </SyncProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("count").textContent).toBe("1");
    });

    getIdentityMap.mockClear();

    act(() => {
      client.emitModelChange("Task", "task-1", "update");
      unmount();
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(getIdentityMap).not.toHaveBeenCalled();
  });

  it("refreshes query consumers after in-place model updates", async () => {
    const client = createTestClient({ state: "syncing" });
    const task = { id: "task-1", title: "Initial" };

    client.setQueryResult({
      data: [task],
      hasMore: false,
      totalCount: 1,
    });

    render(
      <SyncProvider client={client}>
        <QueryProbe />
      </SyncProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("firstTitle").textContent).toBe("Initial");
    });

    act(() => {
      task.title = "Updated";
      client.emitModelChange("Task", "task-1", "update");
    });

    await waitFor(() => {
      expect(screen.getByTestId("firstTitle").textContent).toBe("Updated");
    });
  });

  it("refreshes query consumers when coalesced changes include a later matching id", async () => {
    const client = createTestClient({ state: "syncing" });
    const tasks = [
      { id: "task-a", title: "A", type: "a" },
      { id: "task-b", title: "B", type: "b" },
    ];

    client.query = vi.fn(
      (_modelName, options?: QueryOptions<(typeof tasks)[number]>) => {
        const data = tasks.filter((task) =>
          options?.where ? options.where(task) : true
        );

        return Promise.resolve({
          data,
          hasMore: false,
          totalCount: data.length,
        });
      }
    ) as typeof client.query;
    client.getIdentityMap = vi.fn(() => {
      const map = new Map<string, (typeof tasks)[number]>();
      for (const task of tasks) {
        map.set(task.id, task);
      }
      return map;
    }) as typeof client.getIdentityMap;

    render(
      <SyncProvider client={client}>
        <QueryFilterProbe type="b" />
      </SyncProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("filteredTitle").textContent).toBe("B");
    });

    act(() => {
      tasks[1].title = "B updated";
      client.emitModelChange("Task", "task-a", "update");
      client.emitModelChange("Task", "task-b", "update");
    });

    await waitFor(() => {
      expect(screen.getByTestId("filteredTitle").textContent).toBe("B updated");
    });
  });

  it("refreshes query consumers after manual refresh of in-place model updates", async () => {
    const client = createTestClient({ state: "syncing" });
    const task = { id: "task-1", title: "Initial" };

    client.query = vi.fn(() =>
      Promise.resolve({
        data: [task],
        hasMore: false,
        totalCount: 1,
      })
    ) as typeof client.query;

    render(
      <SyncProvider client={client}>
        <QueryProbe />
      </SyncProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("firstTitle").textContent).toBe("Initial");
    });

    task.title = "Updated";

    fireEvent.click(screen.getByTestId("refresh"));

    await waitFor(() => {
      expect(screen.getByTestId("firstTitle").textContent).toBe("Updated");
    });
  });

  it("keeps previous query data when a refresh fails", async () => {
    const client = createTestClient({ state: "syncing" });

    client.setQueryResult({
      data: [{ id: "task-1", title: "First" }],
      hasMore: false,
      totalCount: 1,
    });

    render(
      <SyncProvider client={client}>
        <QueryProbe />
      </SyncProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("count").textContent).toBe("1");
    });

    const failingQuery = vi.fn(() =>
      Promise.reject(new Error("temporary failure"))
    );
    client.query = failingQuery as typeof client.query;

    fireEvent.click(screen.getByTestId("refresh"));

    await waitFor(() => {
      expect(failingQuery).toHaveBeenCalledOnce();
    });

    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toBe("temporary failure");
    });

    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(screen.getByTestId("firstTitle").textContent).toBe("First");
  });

  it("clears query metadata when skip becomes true", async () => {
    const client = createTestClient({ state: "syncing" });

    client.setQueryResult({
      data: [{ id: "task-1", title: "First" }],
      hasMore: true,
      totalCount: 2,
    });

    const { rerender } = render(
      <SyncProvider client={client}>
        <QueryProbe />
      </SyncProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("count").textContent).toBe("1");
    });

    rerender(
      <SyncProvider client={client}>
        <QueryProbe skip />
      </SyncProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("count").textContent).toBe("0");
    });

    expect(screen.getByTestId("hasMore").textContent).toBe("false");
    expect(screen.getByTestId("totalCount").textContent).toBe("0");
    expect(screen.getByTestId("error").textContent).toBe("");
  });

  it("ignores stale query results after a newer refresh resolves", async () => {
    const client = createTestClient({ state: "syncing" });
    const initialQuery = createDeferred<QueryResult<Task>>();
    const refreshedQuery = createDeferred<QueryResult<Task>>();
    let callCount = 0;

    client.query = vi.fn(() => {
      callCount += 1;
      if (callCount === 1) {
        return initialQuery.promise;
      }
      return refreshedQuery.promise;
    }) as typeof client.query;

    render(
      <SyncProvider client={client}>
        <QueryProbe />
      </SyncProvider>
    );

    await waitFor(() => {
      expect(client.query).toHaveBeenCalledOnce();
    });

    fireEvent.click(screen.getByTestId("refresh"));

    await waitFor(() => {
      expect(client.query).toHaveBeenCalledTimes(2);
    });

    act(() => {
      refreshedQuery.resolve({
        data: [{ id: "task-2", title: "Fresh" }],
        hasMore: false,
        totalCount: 1,
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("firstTitle").textContent).toBe("Fresh");
    });

    act(() => {
      initialQuery.resolve({
        data: [{ id: "task-1", title: "Stale" }],
        hasMore: false,
        totalCount: 1,
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("firstTitle").textContent).toBe("Fresh");
    });
  });

  it("ignores stale query results after a synchronous model-change refresh", async () => {
    const client = createTestClient({ state: "syncing" });
    const initialQuery = createDeferred<QueryResult<Task>>();
    let currentMapData: Task[] = [];

    client.query = vi.fn(() => initialQuery.promise) as typeof client.query;
    client.getIdentityMap = vi.fn(() => {
      const map = new Map<string, Task>();
      for (const task of currentMapData) {
        map.set(task.id, task);
      }
      return map;
    }) as typeof client.getIdentityMap;

    render(
      <SyncProvider client={client}>
        <QueryProbe />
      </SyncProvider>
    );

    await waitFor(() => {
      expect(client.query).toHaveBeenCalledOnce();
    });

    act(() => {
      currentMapData = [{ id: "task-2", title: "Fresh" }];
      client.emitModelChange("Task", "task-2", "update");
    });

    await waitFor(() => {
      expect(screen.getByTestId("firstTitle").textContent).toBe("Fresh");
    });

    act(() => {
      initialQuery.resolve({
        data: [{ id: "task-1", title: "Stale" }],
        hasMore: false,
        totalCount: 1,
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("firstTitle").textContent).toBe("Fresh");
    });
  });

  it("loads models through ensureModel and refreshes on updates", async () => {
    const client = createTestClient({ state: "syncing" });
    client.setEnsureModelResult({ id: "task-1", title: "Initial" });

    const { rerender } = render(
      <SyncProvider client={client}>
        <ModelProbe id={null} />
      </SyncProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    expect(screen.getByTestId("found").textContent).toBe("false");

    rerender(
      <SyncProvider client={client}>
        <ModelProbe id="task-1" />
      </SyncProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("title").textContent).toBe("Initial");
    });

    client.setEnsureModelResult({ id: "task-1", title: "Updated" });

    act(() => {
      client.emitModelChange("Task", "task-1", "update");
    });

    await waitFor(() => {
      expect(screen.getByTestId("title").textContent).toBe("Updated");
    });

    expect(client.ensureModel).toHaveBeenCalledTimes(2);
  });

  it("guards useModelState against stale ensureModel resolutions", async () => {
    const client = createTestClient({ state: "syncing" });
    const slowRequest = createDeferred<Task | null>();
    const fastRequest = createDeferred<Task | null>();

    client.ensureModel = vi.fn((_modelName: string, id: string) => {
      if (id === "slow") {
        return slowRequest.promise;
      }

      return fastRequest.promise;
    }) as typeof client.ensureModel;

    const { rerender } = render(
      <SyncProvider client={client}>
        <ModelProbe id="slow" />
      </SyncProvider>
    );

    rerender(
      <SyncProvider client={client}>
        <ModelProbe id="fast" />
      </SyncProvider>
    );

    act(() => {
      fastRequest.resolve({ id: "fast", title: "Fast" });
    });

    await waitFor(() => {
      expect(screen.getByTestId("title").textContent).toBe("Fast");
    });

    act(() => {
      slowRequest.resolve({ id: "slow", title: "Slow" });
    });

    await waitFor(() => {
      expect(screen.getByTestId("title").textContent).toBe("Fast");
    });
  });

  it("clears useModelState data while a different model id is loading", async () => {
    const client = createTestClient({ state: "syncing" });
    const firstRequest = createDeferred<Task | null>();
    const secondRequest = createDeferred<Task | null>();

    client.ensureModel = vi.fn((_modelName: string, id: string) => {
      if (id === "task-1") {
        return firstRequest.promise;
      }

      return secondRequest.promise;
    }) as typeof client.ensureModel;

    const { rerender } = render(
      <SyncProvider client={client}>
        <ModelProbe id="task-1" />
      </SyncProvider>
    );

    act(() => {
      firstRequest.resolve({ id: "task-1", title: "First" });
    });

    await waitFor(() => {
      expect(screen.getByTestId("title").textContent).toBe("First");
    });

    rerender(
      <SyncProvider client={client}>
        <ModelProbe id="task-2" />
      </SyncProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("true");
    });
    expect(screen.getByTestId("title").textContent).toBe("");
    expect(screen.getByTestId("found").textContent).toBe("false");

    act(() => {
      secondRequest.resolve({ id: "task-2", title: "Second" });
    });

    await waitFor(() => {
      expect(screen.getByTestId("title").textContent).toBe("Second");
    });
  });

  it("keeps the useModelState modelChange subscription stable when readiness changes", async () => {
    const client = createTestClient({ state: "bootstrapping" });
    const originalOnEvent = client.onEvent.bind(client);
    const unsubscribeSpies: ReturnType<typeof vi.fn>[] = [];

    // oxlint-disable-next-line prefer-await-to-callbacks -- mock callback pattern
    client.onEvent = vi.fn((callback) => {
      const unsubscribe = originalOnEvent(callback);
      const trackedUnsubscribe = vi.fn(() => {
        unsubscribe();
      });

      unsubscribeSpies.push(trackedUnsubscribe);
      return trackedUnsubscribe;
    }) as typeof client.onEvent;
    client.setEnsureModelResult({ id: "task-1", title: "Ready" });

    render(
      <SyncProvider client={client}>
        <ModelProbe id="task-1" />
      </SyncProvider>
    );

    await waitFor(() => {
      expect(client.onEvent).toHaveBeenCalledTimes(2);
    });

    act(() => {
      client.emitStateChange("syncing");
    });

    await waitFor(() => {
      expect(screen.getByTestId("title").textContent).toBe("Ready");
    });

    expect(client.onEvent).toHaveBeenCalledTimes(2);
    expect(
      unsubscribeSpies.filter((spy) => spy.mock.calls.length > 0)
    ).toHaveLength(0);
  });

  it("re-renders useModel consumers for in-place cached model updates", async () => {
    const client = createTestClient({ state: "syncing" });
    const task = { id: "task-1", title: "Initial" };

    client.getCached = vi.fn((_modelName: string, id: string) =>
      id === task.id ? task : null
    ) as typeof client.getCached;

    render(
      <SyncProvider client={client}>
        <SuspenseModelProbe id="task-1" />
      </SyncProvider>
    );

    expect(screen.getByTestId("suspenseTitle").textContent).toBe("Initial");

    act(() => {
      task.title = "Updated";
      client.emitModelChange("Task", "task-1", "update");
    });

    await waitFor(() => {
      expect(screen.getByTestId("suspenseTitle").textContent).toBe("Updated");
    });
  });

  it("does not add separate ready listeners for suspended models", () => {
    const client = createTestClient({ state: "bootstrapping" });
    const originalOnEvent = client.onEvent.bind(client);
    const unsubscribeSpies: ReturnType<typeof vi.fn>[] = [];

    // oxlint-disable-next-line prefer-await-to-callbacks -- mock callback pattern
    client.onEvent = vi.fn((callback) => {
      const unsubscribe = originalOnEvent(callback);
      const trackedUnsubscribe = vi.fn(() => {
        unsubscribe();
      });

      unsubscribeSpies.push(trackedUnsubscribe);
      return trackedUnsubscribe;
    }) as typeof client.onEvent;

    const { unmount } = render(
      <SyncProvider client={client}>
        <Suspense fallback={<div data-testid="fallback">loading</div>}>
          <SuspenseModelProbe id="task-1" />
          <SuspenseModelProbe id="task-1" />
        </Suspense>
      </SyncProvider>
    );

    expect(screen.getByTestId("fallback").textContent).toBe("loading");
    expect(client.onEvent).toHaveBeenCalledOnce();

    unmount();

    expect(
      unsubscribeSpies.filter((spy) => spy.mock.calls.length > 0)
    ).toHaveLength(1);
  });

  it("exports the documented helper hooks from the package entrypoint", async () => {
    const client = createTestClient({ state: "syncing" });

    client.setQueryResult({
      data: [{ id: "task-1", title: "Counted" }],
      hasMore: false,
      totalCount: 1,
    });

    render(
      <SyncProvider client={client}>
        <QueryCountProbe />
      </SyncProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("queryCount").textContent).toBe("1");
    });

    expect(useModelSuspense).toBe(useModel);
  });
});
