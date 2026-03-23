import {
  clearPersistedYjsDocuments,
  createPersistedYjsPrefix,
  fromDocumentKeyString,
  isLiveEditingErrorMessage,
  isSessionStateMessage,
  isYjsSyncStep2Message,
  isYjsUpdateMessage,
  toDocumentKeyString,
  YjsDocumentManager,
  YjsPresenceManager,
} from "../src/index";
import type {
  ClientMessage,
  ConnectOptions,
  DocumentConnectionState,
  DocumentKey,
  LiveEditingErrorMessage,
  ServerMessage,
  SessionState,
  YjsDocumentManagerConfig,
  YjsTransport,
  YjsTransportConnectionState,
} from "../src/index";

const assertPublicTypes = (
  _docKey: DocumentKey,
  _config: YjsDocumentManagerConfig,
  _options: ConnectOptions,
  _connectionState: DocumentConnectionState,
  _sessionState: SessionState,
  _transport: YjsTransport,
  _transportState: YjsTransportConnectionState,
  _clientMessage: ClientMessage,
  _serverMessage: ServerMessage,
  _errorMessage: LiveEditingErrorMessage
): void => {
  /* noop */
};

describe("public api", () => {
  it("exports the documented runtime helpers and managers", () => {
    expect(YjsDocumentManager).toBeDefined();
    expect(YjsPresenceManager).toBeDefined();
    expectTypeOf(toDocumentKeyString).toBeFunction();
    expectTypeOf(fromDocumentKeyString).toBeFunction();
    expectTypeOf(createPersistedYjsPrefix).toBeFunction();
    expectTypeOf(clearPersistedYjsDocuments).toBeFunction();
    expectTypeOf(isYjsSyncStep2Message).toBeFunction();
    expectTypeOf(isYjsUpdateMessage).toBeFunction();
    expectTypeOf(isSessionStateMessage).toBeFunction();
    expectTypeOf(isLiveEditingErrorMessage).toBeFunction();
  });

  it("type-checks documented root imports", () => {
    const docKey: DocumentKey = {
      entityId: "task-123",
      entityType: "Task",
      fieldName: "description",
    };
    const config: YjsDocumentManagerConfig = {
      clientId: "client-123",
      connId: "conn-123",
    };
    const options: ConnectOptions = { initialContent: "Hello" };
    const connectionState: DocumentConnectionState = "connected";
    const sessionState: SessionState = {
      active: true,
      participants: [{ isEditing: true, userId: "user-1" }],
    };
    const transport: YjsTransport = {
      isConnected: () => true,
      onConnectionStateChange: () => () => {
        /* noop */
      },
      onMessage: () => () => {
        /* noop */
      },
      send: () => {
        /* noop */
      },
    };
    const transportState: YjsTransportConnectionState = "connected";
    const clientMessage: ClientMessage = {
      ...docKey,
      clientId: "client-123",
      connId: "conn-123",
      state: "start",
      type: "doc_view",
    };
    const serverMessage: ServerMessage = {
      ...docKey,
      payload: "",
      seq: 1,
      type: "yjs_sync_step2",
    };
    const errorMessage: LiveEditingErrorMessage = {
      ...docKey,
      code: "RATE_LIMITED",
      error: "rate limited",
      type: "live_editing_error",
    };

    assertPublicTypes(
      docKey,
      config,
      options,
      connectionState,
      sessionState,
      transport,
      transportState,
      clientMessage,
      serverMessage,
      errorMessage
    );

    expect(toDocumentKeyString(docKey)).toBe("Task:task-123:description");
  });
});
