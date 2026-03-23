import { YjsPresenceManager } from "../src/presence-manager";
import type { DocumentKey } from "../src/types";
import { createMockTransport } from "./mock-transport";

describe(YjsPresenceManager, () => {
  let manager: YjsPresenceManager;
  let transport: ReturnType<typeof createMockTransport>;

  const testDocKey: DocumentKey = {
    entityId: "test-task-123",
    entityType: "Task",
    fieldName: "description",
  };

  beforeEach(() => {
    transport = createMockTransport();
    manager = new YjsPresenceManager({
      clientId: "test-client",
      connId: "test-conn",
    });
    manager.setTransport(transport);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("startViewing", () => {
    it("should send doc_view start message", () => {
      manager.startViewing(testDocKey);

      expect(transport.send).toHaveBeenCalledWith({
        clientId: "test-client",
        connId: "test-conn",
        entityId: "test-task-123",
        entityType: "Task",
        fieldName: "description",
        state: "start",
        type: "doc_view",
      });
    });

    it("should mark document as viewing", () => {
      manager.startViewing(testDocKey);

      expect(manager.isViewing(testDocKey)).toBeTruthy();
    });

    it("should not send duplicate start messages", () => {
      manager.startViewing(testDocKey);
      manager.startViewing(testDocKey);

      const startMessages = transport.sentMessages.filter(
        (m) => m.type === "doc_view" && m.state === "start"
      );
      expect(startMessages).toHaveLength(1);
    });
  });

  describe("stopViewing", () => {
    it("should send doc_view stop message", () => {
      manager.startViewing(testDocKey);
      manager.stopViewing(testDocKey);

      expect(transport.send).toHaveBeenCalledWith(
        expect.objectContaining({
          state: "stop",
          type: "doc_view",
        })
      );
    });

    it("should mark document as not viewing", () => {
      manager.startViewing(testDocKey);
      manager.stopViewing(testDocKey);

      expect(manager.isViewing(testDocKey)).toBeFalsy();
    });

    it("should blur before stopping if editing", () => {
      manager.startViewing(testDocKey);
      manager.focus(testDocKey);
      manager.stopViewing(testDocKey);

      const blurMessage = transport.sentMessages.find(
        (m) => m.type === "doc_focus" && m.state === "blur"
      );
      expect(blurMessage).toBeDefined();
    });

    it("should not send stop message if not viewing", () => {
      manager.stopViewing(testDocKey);

      expect(transport.send).not.toHaveBeenCalled();
    });
  });

  describe("focus", () => {
    it("should send doc_focus message", () => {
      manager.startViewing(testDocKey);
      manager.focus(testDocKey);

      expect(transport.send).toHaveBeenCalledWith({
        clientId: "test-client",
        connId: "test-conn",
        entityId: "test-task-123",
        entityType: "Task",
        fieldName: "description",
        state: "focus",
        type: "doc_focus",
      });
    });

    it("should mark document as editing", () => {
      manager.startViewing(testDocKey);
      manager.focus(testDocKey);

      expect(manager.isEditing(testDocKey)).toBeTruthy();
    });

    it("should start viewing if not already viewing", () => {
      manager.focus(testDocKey);

      expect(manager.isViewing(testDocKey)).toBeTruthy();
      expect(manager.isEditing(testDocKey)).toBeTruthy();
    });

    it("should not send duplicate focus messages", () => {
      manager.startViewing(testDocKey);
      manager.focus(testDocKey);
      manager.focus(testDocKey);

      const focusMessages = transport.sentMessages.filter(
        (m) => m.type === "doc_focus" && m.state === "focus"
      );
      expect(focusMessages).toHaveLength(1);
    });
  });

  describe("blur", () => {
    it("should send doc_focus blur message", () => {
      manager.startViewing(testDocKey);
      manager.focus(testDocKey);
      manager.blur(testDocKey);

      expect(transport.send).toHaveBeenCalledWith({
        clientId: "test-client",
        connId: "test-conn",
        entityId: "test-task-123",
        entityType: "Task",
        fieldName: "description",
        state: "blur",
        type: "doc_focus",
      });
    });

    it("should mark document as not editing", () => {
      manager.startViewing(testDocKey);
      manager.focus(testDocKey);
      manager.blur(testDocKey);

      expect(manager.isEditing(testDocKey)).toBeFalsy();
      expect(manager.isViewing(testDocKey)).toBeTruthy();
    });

    it("should not send blur if not editing", () => {
      manager.startViewing(testDocKey);
      manager.blur(testDocKey);

      const blurMessages = transport.sentMessages.filter(
        (m) => m.type === "doc_focus" && m.state === "blur"
      );
      expect(blurMessages).toHaveLength(0);
    });
  });

  describe("session state", () => {
    it("should update session state from server message", () => {
      manager.startViewing(testDocKey);

      transport.triggerMessage({
        active: true,
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        participants: [
          { isEditing: true, userId: "user-1" },
          { isEditing: false, userId: "user-2" },
        ],
        type: "session_state",
      });

      const state = manager.getSessionState(testDocKey);
      expect(state).toEqual({
        active: true,
        participants: [
          { isEditing: true, userId: "user-1" },
          { isEditing: false, userId: "user-2" },
        ],
      });
    });

    it("should return null for unknown documents", () => {
      expect(manager.getSessionState(testDocKey)).toBeNull();
    });

    it("should notify callbacks on session state change", () => {
      const callback = vi.fn();
      manager.startViewing(testDocKey);
      manager.onSessionStateChange(testDocKey, callback);

      transport.triggerMessage({
        active: true,
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        participants: [{ isEditing: true, userId: "user-1" }],
        type: "session_state",
      });

      expect(callback).toHaveBeenCalledWith({
        active: true,
        participants: [{ isEditing: true, userId: "user-1" }],
      });
    });

    it("should call callback immediately if session state exists", () => {
      const callback = vi.fn();
      manager.startViewing(testDocKey);

      transport.triggerMessage({
        active: true,
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        participants: [],
        type: "session_state",
      });

      manager.onSessionStateChange(testDocKey, callback);

      expect(callback).toHaveBeenCalledWith({
        active: true,
        participants: [],
      });
    });

    it("should allow unsubscription", () => {
      const callback = vi.fn();
      manager.startViewing(testDocKey);
      const unsubscribe = manager.onSessionStateChange(testDocKey, callback);

      callback.mockClear();
      unsubscribe();

      transport.triggerMessage({
        active: false,
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        participants: [],
        type: "session_state",
      });

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("cleanup", () => {
    it("should stop viewing all documents", () => {
      manager.startViewing(testDocKey);
      manager.startViewing({ ...testDocKey, entityId: "other-id" });

      manager.cleanup();

      expect(manager.isViewing(testDocKey)).toBeFalsy();
      expect(
        manager.isViewing({ ...testDocKey, entityId: "other-id" })
      ).toBeFalsy();
    });

    it("should send stop messages for all documents", () => {
      manager.startViewing(testDocKey);
      manager.startViewing({ ...testDocKey, entityId: "other-id" });

      manager.cleanup();

      const stopMessages = transport.sentMessages.filter(
        (m) => m.type === "doc_view" && m.state === "stop"
      );
      expect(stopMessages).toHaveLength(2);
    });
  });

  describe("reconnect replay", () => {
    it("should replay active viewing and editing state on reconnect", () => {
      manager.startViewing(testDocKey);
      manager.focus(testDocKey);

      transport.sentMessages.length = 0;

      transport.triggerConnectionState("disconnected");
      transport.triggerConnectionState("connected");

      expect(transport.sentMessages).toEqual([
        {
          clientId: "test-client",
          connId: "test-conn",
          entityId: "test-task-123",
          entityType: "Task",
          fieldName: "description",
          state: "start",
          type: "doc_view",
        },
        {
          clientId: "test-client",
          connId: "test-conn",
          entityId: "test-task-123",
          entityType: "Task",
          fieldName: "description",
          state: "focus",
          type: "doc_focus",
        },
      ]);
    });

    it("should not replay presence twice when a retry timer is pending", () => {
      vi.useFakeTimers();
      transport = createMockTransport();
      manager = new YjsPresenceManager({
        clientId: "test-client",
        connId: "test-conn",
        liveEditingRetry: {
          baseDelayMs: 100,
          jitter: 0,
          maxDelayMs: 100,
          maxRetries: 3,
        },
      });
      manager.setTransport(transport);

      manager.startViewing(testDocKey);
      manager.focus(testDocKey);
      transport.sentMessages.length = 0;

      transport.triggerMessage({
        code: "SUBSCRIBE_REQUIRED",
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        error: "subscription required",
        fieldName: testDocKey.fieldName,
        type: "live_editing_error",
      });

      transport.triggerConnectionState("disconnected");
      transport.triggerConnectionState("connected");

      expect(transport.sentMessages).toEqual([
        {
          clientId: "test-client",
          connId: "test-conn",
          entityId: "test-task-123",
          entityType: "Task",
          fieldName: "description",
          state: "start",
          type: "doc_view",
        },
        {
          clientId: "test-client",
          connId: "test-conn",
          entityId: "test-task-123",
          entityType: "Task",
          fieldName: "description",
          state: "focus",
          type: "doc_focus",
        },
      ]);

      vi.advanceTimersByTime(100);

      expect(transport.sentMessages).toHaveLength(2);
    });

    it("should replay only viewing state when not editing", () => {
      manager.startViewing(testDocKey);

      transport.sentMessages.length = 0;

      transport.triggerConnectionState("disconnected");
      transport.triggerConnectionState("connected");

      expect(transport.sentMessages).toEqual([
        {
          clientId: "test-client",
          connId: "test-conn",
          entityId: "test-task-123",
          entityType: "Task",
          fieldName: "description",
          state: "start",
          type: "doc_view",
        },
      ]);
    });
  });

  describe("session state listeners", () => {
    it("should preserve listeners across stop and start viewing cycles", () => {
      const callback = vi.fn();

      manager.startViewing(testDocKey);
      manager.onSessionStateChange(testDocKey, callback);

      transport.triggerMessage({
        active: true,
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        participants: [{ isEditing: true, userId: "user-1" }],
        type: "session_state",
      });

      expect(callback).toHaveBeenCalledWith({
        active: true,
        participants: [{ isEditing: true, userId: "user-1" }],
      });

      callback.mockClear();
      manager.stopViewing(testDocKey);
      manager.startViewing(testDocKey);

      transport.triggerMessage({
        active: false,
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        participants: [],
        type: "session_state",
      });

      expect(callback).toHaveBeenCalledWith({
        active: false,
        participants: [],
      });
    });

    it("should remove empty callback sets after unsubscribe", () => {
      manager.startViewing(testDocKey);

      const keyString = `${testDocKey.entityType}:${testDocKey.entityId}:${testDocKey.fieldName}`;
      const callback = vi.fn();
      const unsubscribe = manager.onSessionStateChange(testDocKey, callback);

      expect(
        (
          manager as unknown as {
            sessionStateCallbacks: Map<string, Set<(state: unknown) => void>>;
          }
        ).sessionStateCallbacks.has(keyString)
      ).toBeTruthy();

      unsubscribe();

      expect(
        (
          manager as unknown as {
            sessionStateCallbacks: Map<string, Set<(state: unknown) => void>>;
          }
        ).sessionStateCallbacks.has(keyString)
      ).toBeFalsy();
    });
  });

  describe("transport not connected", () => {
    it("should not send messages when transport is disconnected", () => {
      transport.triggerConnectionState("disconnected");

      manager.startViewing(testDocKey);

      expect(transport.send).not.toHaveBeenCalled();
    });
  });

  describe("live editing errors", () => {
    it("replays presence state with bounded exponential backoff", () => {
      vi.useFakeTimers();
      transport = createMockTransport();
      manager = new YjsPresenceManager({
        clientId: "test-client",
        connId: "test-conn",
        liveEditingRetry: {
          baseDelayMs: 100,
          jitter: 0,
          maxDelayMs: 200,
          maxRetries: 2,
        },
      });
      manager.setTransport(transport);
      manager.startViewing(testDocKey);
      manager.focus(testDocKey);
      transport.sentMessages.length = 0;

      const triggerRetryableError = () => {
        transport.triggerMessage({
          code: "SUBSCRIBE_REQUIRED",
          entityId: testDocKey.entityId,
          entityType: testDocKey.entityType,
          error: "subscription required",
          fieldName: testDocKey.fieldName,
          type: "live_editing_error",
        });
      };

      triggerRetryableError();
      expect(transport.sentMessages).toHaveLength(0);

      vi.advanceTimersByTime(100);
      expect(transport.sentMessages).toEqual([
        {
          clientId: "test-client",
          connId: "test-conn",
          entityId: "test-task-123",
          entityType: "Task",
          fieldName: "description",
          state: "start",
          type: "doc_view",
        },
        {
          clientId: "test-client",
          connId: "test-conn",
          entityId: "test-task-123",
          entityType: "Task",
          fieldName: "description",
          state: "focus",
          type: "doc_focus",
        },
      ]);

      transport.sentMessages.length = 0;

      triggerRetryableError();
      vi.advanceTimersByTime(200);
      expect(transport.sentMessages).toEqual([
        {
          clientId: "test-client",
          connId: "test-conn",
          entityId: "test-task-123",
          entityType: "Task",
          fieldName: "description",
          state: "start",
          type: "doc_view",
        },
        {
          clientId: "test-client",
          connId: "test-conn",
          entityId: "test-task-123",
          entityType: "Task",
          fieldName: "description",
          state: "focus",
          type: "doc_focus",
        },
      ]);

      transport.sentMessages.length = 0;

      triggerRetryableError();
      vi.runOnlyPendingTimers();
      expect(transport.sentMessages).toHaveLength(0);
    });
  });
});
