import type { SyncClient } from "@stratasync/client";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import React from "react";

import {
  SyncBacklogContext,
  SyncClientContext,
  SyncContext,
  SyncStatusContext,
  useYjsDocument,
} from "../src";

// Mock Yjs
vi.mock(import("yjs"), () => ({
  Doc: class MockDoc {
    getText() {
      return {
        insert: vi.fn(),
        toString: () => "mock content",
      };
    }
    destroy() {
      // No-op for mock
    }
  },
}));

// Create a mock sync client with Yjs support
const createMockClient = (
  options: { isReady?: boolean; hasYjs?: boolean } = {}
) => {
  const { isReady = true, hasYjs = true } = options;

  const mockDoc = {
    destroy: vi.fn(),
    getText: () => ({
      insert: vi.fn(),
      toString: () => "test content",
    }),
  };

  const connectionStateCallbacks: ((state: string) => void)[] = [];
  const contentCallbacks: ((content: string) => void)[] = [];
  const sessionCallbacks: ((state: {
    active: boolean;
    participants: { userId: string; isEditing: boolean }[];
  }) => void)[] = [];

  const documentManager = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    getDocument: vi.fn(() => mockDoc),
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    onConnectionStateChange: vi.fn((_, callback) => {
      connectionStateCallbacks.push(callback);
      // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
      callback("disconnected");
      return () => {
        const idx = connectionStateCallbacks.indexOf(callback);
        if (idx !== -1) {
          connectionStateCallbacks.splice(idx, 1);
        }
      };
    }),
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    onContentChange: vi.fn((_, callback) => {
      contentCallbacks.push(callback);
      // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
      callback("test content");
      return () => {
        const idx = contentCallbacks.indexOf(callback);
        if (idx !== -1) {
          contentCallbacks.splice(idx, 1);
        }
      };
    }),
  };

  const presenceManager = {
    blur: vi.fn(),
    focus: vi.fn(),
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    onSessionStateChange: vi.fn((_, callback) => {
      sessionCallbacks.push(callback);
      // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
      callback({ active: false, participants: [] });
      return () => {
        const idx = sessionCallbacks.indexOf(callback);
        if (idx !== -1) {
          sessionCallbacks.splice(idx, 1);
        }
      };
    }),
    startViewing: vi.fn(),
    stopViewing: vi.fn(),
  };

  return {
    client: {
      ...(hasYjs && {
        yjs: {
          documentManager,
          presenceManager,
        },
      }),
    },
    connectionStateCallbacks,
    contentCallbacks,
    documentManager,
    isReady,
    mockDoc,
    presenceManager,
    sessionCallbacks,
  };
};

const createWrapper = (mockData: ReturnType<typeof createMockClient>) =>
  function Wrapper({ children }: { children: ReactNode }) {
    const contextValue = {
      backlog: 0,
      client: mockData.client as unknown as SyncClient,
      clientId: "test-client",
      connectionState: "connected" as const,
      error: null,
      isOffline: false,
      isReady: mockData.isReady,
      isSyncing: false,
      lastSyncId: 0,
      readyPromise: Promise.resolve(),
      state: "syncing" as const,
    };

    return React.createElement(
      SyncClientContext.Provider,
      { value: contextValue.client },
      React.createElement(
        SyncStatusContext.Provider,
        { value: contextValue },
        React.createElement(
          SyncBacklogContext.Provider,
          { value: contextValue.backlog },
          React.createElement(
            SyncContext.Provider,
            { value: contextValue },
            children
          )
        )
      )
    );
  };

describe(useYjsDocument, () => {
  const testDocKey = {
    entityId: "test-task-123",
    entityType: "Task",
    fieldName: "description",
  };
  const alternateDocKey = {
    entityId: "test-task-456",
    entityType: "Task",
    fieldName: "description",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("initial state", () => {
    it("should return disconnected state initially", () => {
      const mockData = createMockClient();
      const { result } = renderHook(() => useYjsDocument(testDocKey), {
        wrapper: createWrapper(mockData),
      });

      expect(result.current.connectionState).toBe("disconnected");
      expect(result.current.isConnected).toBeFalsy();
      expect(result.current.doc).toBeNull();
    });

    it("connects even when sync-ready flag is false", () => {
      const mockData = createMockClient({ isReady: false });
      const { result } = renderHook(
        () => useYjsDocument(testDocKey, { autoConnect: true }),
        { wrapper: createWrapper(mockData) }
      );

      expect(result.current.doc).not.toBeNull();
      expect(mockData.documentManager.connect).toHaveBeenCalledWith(
        testDocKey,
        expect.objectContaining({})
      );
    });
  });

  describe("autoConnect", () => {
    it("should connect automatically when autoConnect is true", () => {
      const mockData = createMockClient();
      renderHook(() => useYjsDocument(testDocKey, { autoConnect: true }), {
        wrapper: createWrapper(mockData),
      });

      expect(mockData.documentManager.connect).toHaveBeenCalledWith(
        testDocKey,
        expect.objectContaining({})
      );
      expect(mockData.presenceManager.startViewing).toHaveBeenCalledWith(
        testDocKey
      );
    });

    it("should not connect when autoConnect is false", () => {
      const mockData = createMockClient();
      renderHook(() => useYjsDocument(testDocKey, { autoConnect: false }), {
        wrapper: createWrapper(mockData),
      });

      expect(mockData.documentManager.connect).not.toHaveBeenCalled();
    });

    it("should not connect when skip is true", () => {
      const mockData = createMockClient();
      renderHook(
        () => useYjsDocument(testDocKey, { autoConnect: true, skip: true }),
        { wrapper: createWrapper(mockData) }
      );

      expect(mockData.documentManager.connect).not.toHaveBeenCalled();
    });

    it("should reconnect when docKey changes and autoConnect is true", () => {
      const mockData = createMockClient();
      const { rerender } = renderHook(
        ({ docKey }) => useYjsDocument(docKey, { autoConnect: true }),
        {
          initialProps: { docKey: testDocKey },
          wrapper: createWrapper(mockData),
        }
      );

      expect(mockData.documentManager.connect).toHaveBeenCalledWith(
        testDocKey,
        expect.objectContaining({})
      );

      act(() => {
        rerender({ docKey: alternateDocKey });
      });

      expect(mockData.presenceManager.stopViewing).toHaveBeenCalledWith(
        testDocKey
      );
      expect(mockData.documentManager.disconnect).toHaveBeenCalledWith(
        testDocKey
      );
      expect(mockData.documentManager.connect).toHaveBeenLastCalledWith(
        alternateDocKey,
        expect.objectContaining({})
      );
      expect(mockData.presenceManager.startViewing).toHaveBeenLastCalledWith(
        alternateDocKey
      );
    });
  });

  describe("manual connect/disconnect", () => {
    it("should connect when connect() is called", () => {
      const mockData = createMockClient();
      const { result } = renderHook(() => useYjsDocument(testDocKey), {
        wrapper: createWrapper(mockData),
      });

      act(() => {
        result.current.connect();
      });

      expect(mockData.documentManager.connect).toHaveBeenCalled();
      expect(result.current.doc).not.toBeNull();
    });

    it("should disconnect when disconnect() is called", () => {
      const mockData = createMockClient();
      const { result } = renderHook(
        () => useYjsDocument(testDocKey, { autoConnect: true }),
        { wrapper: createWrapper(mockData) }
      );

      act(() => {
        result.current.disconnect();
      });

      expect(mockData.documentManager.disconnect).toHaveBeenCalled();
      expect(mockData.presenceManager.stopViewing).toHaveBeenCalled();
    });
  });

  describe("without Yjs support", () => {
    it("should handle missing Yjs manager gracefully", () => {
      const mockData = createMockClient({ hasYjs: false });
      const { result } = renderHook(
        () => useYjsDocument(testDocKey, { autoConnect: true }),
        { wrapper: createWrapper(mockData) }
      );

      // Should not throw, but should set error state
      expect(result.current.doc).toBeNull();
      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe(
        "Yjs document manager not available on client"
      );
    });

    it("clears stale errors after a later successful connect", () => {
      const mockData = createMockClient({ hasYjs: false });
      const { result } = renderHook(() => useYjsDocument(testDocKey), {
        wrapper: createWrapper(mockData),
      });

      act(() => {
        result.current.connect();
      });

      expect(result.current.error?.message).toBe(
        "Yjs document manager not available on client"
      );

      (
        mockData.client as {
          yjs?: {
            documentManager: typeof mockData.documentManager;
            presenceManager: typeof mockData.presenceManager;
          };
        }
      ).yjs = {
        documentManager: mockData.documentManager,
        presenceManager: mockData.presenceManager,
      };

      act(() => {
        result.current.connect();
      });

      expect(result.current.error).toBeNull();
      expect(result.current.doc).not.toBeNull();
    });
  });

  describe("session state", () => {
    it("should track session state from callbacks", () => {
      const mockData = createMockClient();
      const { result } = renderHook(
        () => useYjsDocument(testDocKey, { autoConnect: true }),
        { wrapper: createWrapper(mockData) }
      );

      act(() => {
        for (const callback of mockData.sessionCallbacks) {
          // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
          callback({
            active: true,
            participants: [
              { isEditing: true, userId: "user-1" },
              { isEditing: false, userId: "user-2" },
            ],
          });
        }
      });

      expect(result.current.isSessionActive).toBeTruthy();
      expect(result.current.participants).toHaveLength(2);
    });
  });

  describe("content updates", () => {
    it("should track content from callbacks", () => {
      const mockData = createMockClient();
      const { result } = renderHook(
        () => useYjsDocument(testDocKey, { autoConnect: true }),
        { wrapper: createWrapper(mockData) }
      );

      act(() => {
        for (const callback of mockData.contentCallbacks) {
          // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
          callback("updated content");
        }
      });

      expect(result.current.content).toBe("updated content");
    });
  });

  describe("cleanup", () => {
    it("should disconnect on unmount", () => {
      const mockData = createMockClient();
      const { unmount } = renderHook(
        () => useYjsDocument(testDocKey, { autoConnect: true }),
        { wrapper: createWrapper(mockData) }
      );

      unmount();

      expect(mockData.documentManager.disconnect).toHaveBeenCalled();
      expect(mockData.presenceManager.stopViewing).toHaveBeenCalled();
    });
  });
});
