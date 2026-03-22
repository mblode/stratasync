// @vitest-environment jsdom

import type {
  QueryOptions,
  QueryResult,
  SyncClient,
  SyncClientEvent,
} from "@stratasync/client";
import { render, waitFor } from "@testing-library/react";

import { NextSyncProvider } from "../src/provider";

const noopUnsubscribe = () => {
  /* noop */
};

const createMockClient = (): SyncClient => {
  const queryResult: QueryResult<Record<string, unknown>> = {
    data: [],
    hasMore: false,
  };

  return {
    archive: vi.fn(async () => {
      /* noop */
    }),
    canRedo: vi.fn(() => false),
    canUndo: vi.fn(() => false),
    clearAll: vi.fn(async () => {
      /* noop */
    }),
    clientId: "test-client",
    connectionState: "connected",
    create: vi.fn(<T extends Record<string, unknown>>(_m: string, d: T) => d),
    delete: vi.fn(async () => {
      /* noop */
    }),
    ensureModel: vi.fn(() => null),
    get: vi.fn(() => null),
    getAll: vi.fn(() => []),
    getCached: vi.fn(() => null),
    getIdentityMap: vi.fn(() => new Map()),
    getPendingCount: vi.fn(() => 0),
    isModelMissing: vi.fn(() => false),
    lastError: null,
    lastSyncId: "0",
    onConnectionStateChange: vi.fn((_callback) => noopUnsubscribe),
    onEvent: vi.fn(
      (_callback: (event: SyncClientEvent) => void) => noopUnsubscribe
    ),
    onStateChange: vi.fn((_callback) => noopUnsubscribe),
    query: vi.fn(
      <T,>(_modelName: string, _options?: QueryOptions<T>) =>
        queryResult as QueryResult<T>
    ),
    redo: vi.fn(async () => {
      /* noop */
    }),
    runAsUndoGroup: vi.fn(
      async (operation: () => Promise<unknown> | unknown) => await operation()
    ),
    start: vi.fn(async () => {
      /* noop */
    }),
    state: "syncing",
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
        _m: string,
        _id: string,
        changes: Partial<T>
      ) => changes as T
    ),
  };
};

afterEach(() => {
  vi.clearAllMocks();
});

describe(NextSyncProvider, () => {
  it("stops factory-owned clients on unmount", async () => {
    const client = createMockClient();
    const { unmount } = render(
      // oxlint-disable-next-line jsx-no-new-function-as-prop -- test-only inline factory
      <NextSyncProvider client={() => client}>
        <div>child</div>
      </NextSyncProvider>
    );

    await waitFor(() => {
      expect(client.start).toHaveBeenCalledOnce();
    });

    unmount();

    await waitFor(() => {
      expect(client.stop).toHaveBeenCalledOnce();
    });
  });

  it("does not stop externally owned clients on unmount", async () => {
    const client = createMockClient();
    const { unmount } = render(
      <NextSyncProvider client={client}>
        <div>child</div>
      </NextSyncProvider>
    );

    await waitFor(() => {
      expect(client.start).toHaveBeenCalledOnce();
    });

    unmount();

    expect(client.stop).not.toHaveBeenCalled();
  });
});
