// @vitest-environment jsdom

import { readFileSync } from "node:fs";

import type {
  QueryOptions,
  QueryResult,
  SyncClient,
  SyncClientEvent,
} from "@stratasync/client";
import type { SyncClientState } from "@stratasync/core";
import { NextSyncProvider } from "@stratasync/next/client";
import {
  encodeBootstrapSnapshot,
  prefetchBootstrap,
  seedStorageFromBootstrap,
  serializeBootstrapSnapshot,
} from "@stratasync/next/server";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";

const noopUnsubscribe = () => {
  /* noop */
};

const renderErrorMessage = (error: Error) => <div>{error.message}</div>;

interface MockClientControls {
  client: SyncClient;
  emitEvent: (event: SyncClientEvent) => void;
  emitStateChange: (state: SyncClientState) => void;
}

const createMockClient = (
  initialState: SyncClientState = "syncing"
): MockClientControls => {
  const queryResult: QueryResult<Record<string, unknown>> = {
    data: [],
    hasMore: false,
  };

  const eventListeners = new Set<(event: SyncClientEvent) => void>();
  const stateListeners = new Set<(state: SyncClientState) => void>();

  const client: SyncClient = {
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
    // oxlint-disable-next-line prefer-await-to-callbacks -- callback shape matches SyncClient API
    onEvent: vi.fn((callback: (event: SyncClientEvent) => void) => {
      eventListeners.add(callback);
      return () => {
        eventListeners.delete(callback);
      };
    }),
    // oxlint-disable-next-line prefer-await-to-callbacks -- callback shape matches SyncClient API
    onStateChange: vi.fn((callback: (state: SyncClientState) => void) => {
      stateListeners.add(callback);
      return () => {
        stateListeners.delete(callback);
      };
    }),
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
    state: initialState,
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

  return {
    client,
    emitEvent: (event) => {
      for (const listener of eventListeners) {
        listener(event);
      }
    },
    emitStateChange: (state) => {
      client.state = state;
      for (const listener of stateListeners) {
        listener(state);
      }
      for (const listener of eventListeners) {
        listener({ state, type: "stateChange" });
      }
    },
  };
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe(NextSyncProvider, () => {
  it("keeps the root package export mapped to the client entrypoint", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      exports?: {
        ".": {
          default?: string;
          import?: string;
          types?: string;
        };
      };
      main?: string;
      types?: string;
    };

    expect(packageJson.main).toBe("./dist/client.js");
    expect(packageJson.types).toBe("./dist/client.d.ts");
    expect(packageJson.exports?.["."].import).toBe("./dist/client.js");
    expect(packageJson.exports?.["."].default).toBe("./dist/client.js");
    expect(packageJson.exports?.["."].types).toBe("./dist/client.d.ts");
  });

  it("exposes the published server entrypoint helpers", () => {
    expect(prefetchBootstrap).toBeTypeOf("function");
    expect(seedStorageFromBootstrap).toBeTypeOf("function");
    expect(serializeBootstrapSnapshot).toBeTypeOf("function");
    expect(encodeBootstrapSnapshot).toBeTypeOf("function");
  });

  it("renders children during server rendering", () => {
    const { client } = createMockClient("connecting");

    const html = renderToString(
      <NextSyncProvider client={client}>
        <div>child</div>
      </NextSyncProvider>
    );

    expect(html).toContain("child");
    expect(client.start).not.toHaveBeenCalled();
  });

  it("does not stop caller-managed clients on unmount by default", async () => {
    const { client } = createMockClient();
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

  it("honors autoStop for caller-managed clients", async () => {
    const { client } = createMockClient();
    const { unmount } = render(
      <NextSyncProvider autoStop client={client}>
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

  it("calls onReady once for already-ready clients", async () => {
    const { client, emitStateChange } = createMockClient("syncing");
    const onReady = vi.fn();

    render(
      <NextSyncProvider client={client} onReady={onReady}>
        <div>child</div>
      </NextSyncProvider>
    );

    await waitFor(() => {
      expect(onReady).toHaveBeenCalledOnce();
    });

    emitStateChange("error");
    emitStateChange("syncing");

    await waitFor(() => {
      expect(onReady).toHaveBeenCalledOnce();
    });
  });

  it("recovers from sync errors after a non-error state change", async () => {
    const { client, emitEvent, emitStateChange } = createMockClient("syncing");

    render(
      <NextSyncProvider client={client} error={renderErrorMessage}>
        <div>child</div>
      </NextSyncProvider>
    );

    emitEvent({ error: new Error("boom"), type: "syncError" });

    await waitFor(() => {
      expect(screen.getByText("boom")).toBeTruthy();
    });

    emitStateChange("syncing");

    await waitFor(() => {
      expect(screen.getByText("child")).toBeTruthy();
    });
  });

  it("switches to replacement client instances on rerender", async () => {
    const firstClient = createMockClient().client;
    const secondClient = createMockClient().client;
    const onReady = vi.fn();

    const { rerender } = render(
      <NextSyncProvider client={firstClient} onReady={onReady}>
        <div>child</div>
      </NextSyncProvider>
    );

    await waitFor(() => {
      expect(firstClient.start).toHaveBeenCalledOnce();
      expect(onReady).toHaveBeenCalledOnce();
    });

    rerender(
      <NextSyncProvider client={secondClient} onReady={onReady}>
        <div>child</div>
      </NextSyncProvider>
    );

    await waitFor(() => {
      expect(secondClient.start).toHaveBeenCalledOnce();
      expect(onReady).toHaveBeenCalledTimes(2);
    });

    expect(firstClient.stop).not.toHaveBeenCalled();
  });
});
