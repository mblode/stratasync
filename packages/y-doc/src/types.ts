/**
 * Identifies a document field that can be collaboratively edited.
 */
export interface DocumentKey {
  entityType: string;
  entityId: string;
  fieldName: string;
}

const encodeDocumentKeyPart = (value: string): string =>
  encodeURIComponent(value);

const decodeDocumentKeyPart = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const toDocumentKeyString = (key: DocumentKey): string =>
  [
    encodeDocumentKeyPart(key.entityType),
    encodeDocumentKeyPart(key.entityId),
    encodeDocumentKeyPart(key.fieldName),
  ].join(":");

export const fromDocumentKeyString = (str: string): DocumentKey | null => {
  const parts = str.split(":");
  if (parts.length !== 3) {
    return null;
  }

  const [encodedEntityType, encodedEntityId, encodedFieldName] = parts;
  if (!(encodedEntityType && encodedEntityId && encodedFieldName)) {
    return null;
  }

  const entityType = decodeDocumentKeyPart(encodedEntityType);
  const entityId = decodeDocumentKeyPart(encodedEntityId);
  const fieldName = decodeDocumentKeyPart(encodedFieldName);
  if (!(entityType && entityId && fieldName)) {
    return null;
  }
  return { entityId, entityType, fieldName };
};

export type DocumentConnectionState =
  | "disconnected"
  | "connecting"
  | "syncing"
  | "connected";

export type YjsTransportConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface SessionParticipant {
  userId: string;
  isEditing: boolean;
}

export interface SessionState {
  active: boolean;
  participants: SessionParticipant[];
}

export interface ConnectOptions {
  /** Initial content to use if document is empty */
  initialContent?: string;
}

export type LiveEditingErrorCode =
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "SUBSCRIBE_REQUIRED"
  | "INVALID_PAYLOAD"
  | "RATE_LIMITED";

export interface LiveEditingRetryConfig {
  /** Maximum number of retry attempts for retryable live-editing errors */
  maxRetries: number;
  /** Base retry delay in milliseconds */
  baseDelayMs: number;
  /** Maximum retry delay in milliseconds */
  maxDelayMs: number;
  /** Jitter factor in range 0-1 */
  jitter: number;
}

export const DEFAULT_LIVE_EDITING_RETRY_CONFIG: LiveEditingRetryConfig = {
  baseDelayMs: 500,
  jitter: 0.2,
  maxDelayMs: 5000,
  maxRetries: 3,
};

const LIVE_EDITING_ERROR_CODES = new Set<LiveEditingErrorCode>([
  "NOT_FOUND",
  "UNAUTHORIZED",
  "SUBSCRIBE_REQUIRED",
  "INVALID_PAYLOAD",
  "RATE_LIMITED",
]);

const RETRYABLE_LIVE_EDITING_ERROR_CODES = new Set<LiveEditingErrorCode>([
  "UNAUTHORIZED",
  "NOT_FOUND",
  "SUBSCRIBE_REQUIRED",
]);

const isLiveEditingErrorCode = (
  value: unknown
): value is LiveEditingErrorCode =>
  typeof value === "string" &&
  LIVE_EDITING_ERROR_CODES.has(value as LiveEditingErrorCode);

export const isRetryableLiveEditingErrorCode = (
  code: LiveEditingErrorCode
): boolean => RETRYABLE_LIVE_EDITING_ERROR_CODES.has(code);

export interface YjsSyncStep2Message extends DocumentKey {
  type: "yjs_sync_step2";
  // base64 encoded
  payload: string;
  seq: number;
}

export interface YjsUpdateMessage extends DocumentKey {
  type: "yjs_update";
  // base64 encoded
  payload: string;
  clientId: string;
  connId: string;
  seq: number;
}

export interface SessionStateMessage extends DocumentKey {
  type: "session_state";
  active: boolean;
  participants: SessionParticipant[];
}

export interface LiveEditingErrorMessage extends DocumentKey {
  type: "live_editing_error";
  error: string;
  code: LiveEditingErrorCode;
}

export interface DocViewMessage extends DocumentKey {
  type: "doc_view";
  state: "start" | "stop";
  clientId: string;
  connId: string;
}

export interface DocFocusMessage extends DocumentKey {
  type: "doc_focus";
  state: "focus" | "blur";
  clientId: string;
  connId: string;
}

export interface YjsSyncStep1Message extends DocumentKey {
  type: "yjs_sync_step1";
  // base64 encoded state vector
  payload: string;
  clientId: string;
}

export interface YjsUpdateToServerMessage extends DocumentKey {
  type: "yjs_update";
  // base64 encoded
  payload: string;
  clientId: string;
  connId: string;
}

export type ServerMessage =
  | YjsSyncStep2Message
  | YjsUpdateMessage
  | SessionStateMessage
  | LiveEditingErrorMessage;

export type ClientMessage =
  | DocViewMessage
  | DocFocusMessage
  | YjsSyncStep1Message
  | YjsUpdateToServerMessage;

const hasMessageType = (msg: unknown, type: string): boolean =>
  typeof msg === "object" &&
  msg !== null &&
  (msg as { type: unknown }).type === type;

export const isYjsSyncStep2Message = (
  msg: unknown
): msg is YjsSyncStep2Message => {
  if (!hasMessageType(msg, "yjs_sync_step2")) {
    return false;
  }

  const message = msg as Record<string, unknown>;
  return (
    typeof message.entityType === "string" &&
    typeof message.entityId === "string" &&
    typeof message.fieldName === "string" &&
    typeof message.payload === "string" &&
    typeof message.seq === "number"
  );
};

export const isYjsUpdateMessage = (msg: unknown): msg is YjsUpdateMessage => {
  if (!hasMessageType(msg, "yjs_update")) {
    return false;
  }

  const message = msg as Record<string, unknown>;
  return (
    typeof message.entityType === "string" &&
    typeof message.entityId === "string" &&
    typeof message.fieldName === "string" &&
    typeof message.payload === "string" &&
    typeof message.clientId === "string" &&
    typeof message.connId === "string" &&
    typeof message.seq === "number"
  );
};

export const isSessionStateMessage = (
  msg: unknown
): msg is SessionStateMessage => {
  if (!hasMessageType(msg, "session_state")) {
    return false;
  }

  const message = msg as Record<string, unknown>;
  return (
    typeof message.entityType === "string" &&
    typeof message.entityId === "string" &&
    typeof message.fieldName === "string" &&
    typeof message.active === "boolean" &&
    Array.isArray(message.participants)
  );
};

export const isLiveEditingErrorMessage = (
  msg: unknown
): msg is LiveEditingErrorMessage => {
  if (!hasMessageType(msg, "live_editing_error")) {
    return false;
  }

  const message = msg as Record<string, unknown>;
  return (
    typeof message.entityType === "string" &&
    typeof message.entityId === "string" &&
    typeof message.fieldName === "string" &&
    typeof message.error === "string" &&
    isLiveEditingErrorCode(message.code)
  );
};

export interface YjsDocumentManagerConfig {
  /** Logical client identity for attribution. May be stable across tabs/sessions. */
  clientId: string;
  /** Connection-scoped identity used for echo suppression. */
  connId: string;
  /** Optional localStorage prefix used for persisted Yjs snapshots. */
  persistenceKeyPrefix?: string;
  /** Retry configuration for retryable live-editing errors. */
  liveEditingRetry?: Partial<LiveEditingRetryConfig>;
}

export interface YjsTransport {
  send(message: ClientMessage): void;
  onMessage(callback: (message: ServerMessage) => void): () => void;
  onConnectionStateChange(
    callback: (state: YjsTransportConnectionState) => void
  ): () => void;
  isConnected(): boolean;
}
