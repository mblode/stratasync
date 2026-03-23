import type { SyncClient } from "@stratasync/client";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import React from "react";

import {
  SyncBacklogContext,
  SyncClientContext,
  SyncContext,
  SyncStatusContext,
  useYjsPresence,
} from "../src";

// Create a mock sync client with Yjs support
const createMockClient = (
  options: { isReady?: boolean; hasYjs?: boolean } = {}
) => {
  const { isReady = true, hasYjs = true } = options;
  let isViewing = false;
  let isEditing = false;

  const presenceManager = {
    blur: vi.fn(() => {
      isEditing = false;
    }),
    focus: vi.fn(() => {
      isViewing = true;
      isEditing = true;
    }),
    isEditing: vi.fn(() => isEditing),
    isViewing: vi.fn(() => isViewing),
    onSessionStateChange: vi.fn(() => () => {
      // No-op unsubscribe function
    }),
    startViewing: vi.fn(() => {
      isViewing = true;
    }),
    stopViewing: vi.fn(() => {
      isViewing = false;
      isEditing = false;
    }),
  };

  return {
    client: {
      ...(hasYjs && {
        yjs: {
          presenceManager,
        },
      }),
    },
    isReady,
    presenceManager,
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

describe(useYjsPresence, () => {
  const testDocKey = {
    entityId: "test-task-123",
    entityType: "Task",
    fieldName: "description",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("startViewing", () => {
    it("should call presenceManager.startViewing", () => {
      const mockData = createMockClient();
      const { result } = renderHook(() => useYjsPresence(testDocKey), {
        wrapper: createWrapper(mockData),
      });

      act(() => {
        result.current.startViewing();
      });

      expect(mockData.presenceManager.startViewing).toHaveBeenCalledWith(
        testDocKey
      );
      expect(result.current.isViewing).toBeTruthy();
      expect(result.current.isEditing).toBeFalsy();
    });

    it("should not start viewing when skip is true", () => {
      const mockData = createMockClient();
      const { result } = renderHook(
        () => useYjsPresence(testDocKey, { skip: true }),
        { wrapper: createWrapper(mockData) }
      );

      act(() => {
        result.current.startViewing();
      });

      expect(mockData.presenceManager.startViewing).not.toHaveBeenCalled();
    });

    it("should start viewing even when client not ready", () => {
      const mockData = createMockClient({ isReady: false });
      const { result } = renderHook(() => useYjsPresence(testDocKey), {
        wrapper: createWrapper(mockData),
      });

      act(() => {
        result.current.startViewing();
      });

      expect(mockData.presenceManager.startViewing).toHaveBeenCalledWith(
        testDocKey
      );
      expect(result.current.isViewing).toBeTruthy();
    });
  });

  describe("stopViewing", () => {
    it("should call presenceManager.stopViewing", () => {
      const mockData = createMockClient();
      const { result } = renderHook(() => useYjsPresence(testDocKey), {
        wrapper: createWrapper(mockData),
      });

      // Start viewing first
      act(() => {
        result.current.startViewing();
      });

      act(() => {
        result.current.stopViewing();
      });

      expect(mockData.presenceManager.stopViewing).toHaveBeenCalledWith(
        testDocKey
      );
    });
  });

  describe("focus/blur", () => {
    it("should call presenceManager.focus", () => {
      const mockData = createMockClient();
      const { result } = renderHook(() => useYjsPresence(testDocKey), {
        wrapper: createWrapper(mockData),
      });

      act(() => {
        result.current.focus();
      });

      expect(mockData.presenceManager.focus).toHaveBeenCalledWith(testDocKey);
      expect(result.current.isViewing).toBeTruthy();
      expect(result.current.isEditing).toBeTruthy();
    });

    it("should call presenceManager.blur", () => {
      const mockData = createMockClient();
      const { result } = renderHook(() => useYjsPresence(testDocKey), {
        wrapper: createWrapper(mockData),
      });

      // Focus first
      act(() => {
        result.current.focus();
      });

      act(() => {
        result.current.blur();
      });

      expect(mockData.presenceManager.blur).toHaveBeenCalledWith(testDocKey);
      expect(result.current.isViewing).toBeTruthy();
      expect(result.current.isEditing).toBeFalsy();
    });

    it("should start viewing automatically when focus is called", () => {
      const mockData = createMockClient();
      const { result } = renderHook(() => useYjsPresence(testDocKey), {
        wrapper: createWrapper(mockData),
      });

      act(() => {
        result.current.focus();
      });

      expect(mockData.presenceManager.startViewing).toHaveBeenCalledWith(
        testDocKey
      );
    });
  });

  describe("without Yjs support", () => {
    it("should handle missing Yjs manager gracefully", () => {
      const mockData = createMockClient({ hasYjs: false });
      const { result } = renderHook(() => useYjsPresence(testDocKey), {
        wrapper: createWrapper(mockData),
      });

      // Should not throw
      act(() => {
        result.current.startViewing();
        result.current.focus();
        result.current.blur();
        result.current.stopViewing();
      });

      // Just verify no errors occurred
      expect(true).toBeTruthy();
    });
  });

  describe("getRef", () => {
    it("should return a ref callback function", () => {
      const mockData = createMockClient();
      const { result } = renderHook(() => useYjsPresence(testDocKey), {
        wrapper: createWrapper(mockData),
      });

      const refCallback = result.current.getRef();
      expectTypeOf(refCallback).toBeFunction();
    });

    it("attaches auto-tracking listeners without throwing", () => {
      const mockData = createMockClient();
      const { result } = renderHook(
        () => useYjsPresence(testDocKey, { trackFocus: true }),
        {
          wrapper: createWrapper(mockData),
        }
      );

      const refCallback = result.current.getRef<HTMLDivElement>();
      const element = document.createElement("div");

      expect(() => {
        act(() => {
          refCallback(element);
        });
      }).not.toThrow();
    });
  });

  describe("cleanup", () => {
    it("should stop viewing on unmount if viewing", () => {
      const mockData = createMockClient();
      const { result, unmount } = renderHook(() => useYjsPresence(testDocKey), {
        wrapper: createWrapper(mockData),
      });

      // Start viewing
      act(() => {
        result.current.startViewing();
      });

      unmount();

      expect(mockData.presenceManager.stopViewing).toHaveBeenCalled();
    });

    it("stops viewing when skip becomes true", () => {
      const mockData = createMockClient();
      const { result, rerender } = renderHook(
        ({ skip }) => useYjsPresence(testDocKey, { skip }),
        {
          initialProps: { skip: false },
          wrapper: createWrapper(mockData),
        }
      );

      act(() => {
        result.current.startViewing();
      });

      act(() => {
        rerender({ skip: true });
      });

      expect(mockData.presenceManager.stopViewing).toHaveBeenCalledWith(
        testDocKey
      );
      expect(result.current.isViewing).toBeFalsy();
    });
  });

  describe("docKey changes", () => {
    it("moves viewing state to the next document key", () => {
      const mockData = createMockClient();
      const nextDocKey = {
        ...testDocKey,
        entityId: "test-task-456",
      };
      const { result, rerender } = renderHook(
        ({ docKey }) => useYjsPresence(docKey),
        {
          initialProps: { docKey: testDocKey },
          wrapper: createWrapper(mockData),
        }
      );

      act(() => {
        result.current.startViewing();
      });

      rerender({ docKey: nextDocKey });

      expect(mockData.presenceManager.stopViewing).toHaveBeenCalledWith(
        testDocKey
      );
      expect(mockData.presenceManager.startViewing).toHaveBeenLastCalledWith(
        nextDocKey
      );
      expect(result.current.isViewing).toBeTruthy();
      expect(result.current.isEditing).toBeFalsy();
    });

    it("moves editing state to the next document key", () => {
      const mockData = createMockClient();
      const nextDocKey = {
        ...testDocKey,
        entityId: "test-task-789",
      };
      const { result, rerender } = renderHook(
        ({ docKey }) => useYjsPresence(docKey),
        {
          initialProps: { docKey: testDocKey },
          wrapper: createWrapper(mockData),
        }
      );

      act(() => {
        result.current.focus();
      });

      rerender({ docKey: nextDocKey });

      expect(mockData.presenceManager.blur).toHaveBeenCalledWith(testDocKey);
      expect(mockData.presenceManager.stopViewing).toHaveBeenCalledWith(
        testDocKey
      );
      expect(mockData.presenceManager.focus).toHaveBeenLastCalledWith(
        nextDocKey
      );
      expect(result.current.isViewing).toBeTruthy();
      expect(result.current.isEditing).toBeTruthy();
    });
  });
});
