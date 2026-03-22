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
import { useCallback } from "react";

import {
  SyncProvider,
  useConnectionState,
  useIsOffline,
  useModelState,
  usePendingCount,
  useQuery,
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
});
