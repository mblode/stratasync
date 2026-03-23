/**
 * React hook for Yjs collaborative document editing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Doc as YDoc } from "yjs";

import { useSyncClientInstance } from "./use-sync-client.js";

/**
 * Document key identifying a collaborative field.
 */
export interface DocumentKey {
  entityType: string;
  entityId: string;
  fieldName: string;
}

/**
 * Connection state for Yjs document.
 */
export type YjsConnectionState =
  | "disconnected"
  | "connecting"
  | "syncing"
  | "connected";

/**
 * Session participant information.
 */
interface SessionParticipant {
  userId: string;
  isEditing: boolean;
}

/**
 * Session state for a collaborative document.
 */
export interface YjsSessionState {
  active: boolean;
  participants: SessionParticipant[];
}

/**
 * Options for useYjsDocument hook.
 */
export interface UseYjsDocumentOptions {
  /** Initial content if document is empty */
  initialContent?: string;
  /** Whether to automatically connect when component mounts */
  autoConnect?: boolean;
  /** Whether to start in editing mode */
  editing?: boolean;
  /** Skip connecting (useful for conditional loading) */
  skip?: boolean;
}

/**
 * Result of useYjsDocument hook.
 */
export interface UseYjsDocumentResult {
  /** The Yjs document instance */
  doc: YDoc | null;
  /** Current connection state */
  connectionState: YjsConnectionState;
  /** Whether the document is connected for collaboration */
  isConnected: boolean;
  /** Whether there's an active collaborative session */
  isSessionActive: boolean;
  /** Current session participants */
  participants: SessionParticipant[];
  /** Current content of the document */
  content: string;
  /** Connect to the document */
  connect: () => void;
  /** Disconnect from the document */
  disconnect: () => void;
  /** Signal editing focus */
  focus: () => void;
  /** Signal editing blur */
  blur: () => void;
  /** Any error that occurred */
  error: Error | null;
}

const toDocumentKeyString = (docKey: DocumentKey): string =>
  `${docKey.entityType}:${docKey.entityId}:${docKey.fieldName}`;

/**
 * Hook to manage a Yjs collaborative document.
 *
 * @param docKey - Document key identifying the field
 * @param options - Hook options
 * @returns UseYjsDocumentResult with document, connection state, and controls
 *
 * @example
 * ```tsx
 * function TaskDescriptionEditor({ taskId }: { taskId: string }) {
 *   const {
 *     doc,
 *     isSessionActive,
 *     participants,
 *   } = useYjsDocument(
 *     { entityType: 'Task', entityId: taskId, fieldName: 'description' },
 *     { autoConnect: true, initialContent: task.description }
 *   );
 *
 *   // doc becomes available after the first render (even offline).
 *   // Initial content is seeded into the local Y.Doc during connect(),
 *   // so the editor shows content immediately without waiting for the server.
 *   return (
 *     <div>
 *       {isSessionActive && (
 *         <div>
 *           Collaborating with: {participants.map(p => p.userId).join(', ')}
 *         </div>
 *       )}
 *       {doc && <TiptapEditor doc={doc} />}
 *     </div>
 *   );
 * }
 * ```
 */
export const useYjsDocument = (
  docKey: DocumentKey,
  options: UseYjsDocumentOptions = {}
): UseYjsDocumentResult => {
  const { autoConnect = false, skip = false } = options;
  const client = useSyncClientInstance();

  const [doc, setDoc] = useState<YDoc | null>(null);
  const [connectionState, setConnectionState] =
    useState<YjsConnectionState>("disconnected");
  const [sessionState, setSessionState] = useState<YjsSessionState>({
    active: false,
    participants: [],
  });
  const [content, setContent] = useState("");
  const [error, setError] = useState<Error | null>(null);

  // Track if we've connected to avoid double connections
  const isConnectedRef = useRef(false);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const connectedDocKeyRef = useRef<DocumentKey | null>(null);
  const previousDocKeyStringRef = useRef(toDocumentKeyString(docKey));
  const docKeyRef = useRef(docKey);
  const optionsRef = useRef(options);
  docKeyRef.current = docKey;
  optionsRef.current = options;

  const connect = useCallback(() => {
    if (skip || isConnectedRef.current) {
      return;
    }

    const currentDocKey = docKeyRef.current;

    try {
      setError(null);

      // Get Yjs document manager from client if available
      const yjsManager = client.yjs;
      if (!yjsManager) {
        setError(new Error("Yjs document manager not available on client"));
        return;
      }

      const currentOptions = optionsRef.current;

      // Get or create document
      const yjsDoc = yjsManager.documentManager.getDocument(currentDocKey);
      setDoc(yjsDoc);

      // Start presence tracking before sync handshake so server can gate
      // sync/update messages to active viewers.
      yjsManager.presenceManager.startViewing(currentDocKey);

      // Connect with options
      yjsManager.documentManager.connect(currentDocKey, {
        initialContent: currentOptions.initialContent,
      });

      if (currentOptions.editing) {
        yjsManager.presenceManager.focus(currentDocKey);
      }

      // Subscribe to connection state changes
      const unsubConnection =
        yjsManager.documentManager.onConnectionStateChange(
          currentDocKey,
          (state: YjsConnectionState) => {
            setConnectionState(state);
          }
        );

      // Subscribe to content changes
      const unsubContent = yjsManager.documentManager.onContentChange(
        currentDocKey,
        (newContent: string) => {
          setContent(newContent);
        }
      );

      // Subscribe to session state changes
      const unsubSession = yjsManager.presenceManager.onSessionStateChange(
        currentDocKey,
        (state: YjsSessionState) => {
          setSessionState(state);
        }
      );

      unsubscribeRef.current = () => {
        unsubConnection();
        unsubContent();
        unsubSession();
      };

      isConnectedRef.current = true;
      connectedDocKeyRef.current = currentDocKey;
    } catch (connectError) {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      connectedDocKeyRef.current = null;
      isConnectedRef.current = false;
      setDoc(null);
      setContent("");
      setConnectionState("disconnected");
      setSessionState({ active: false, participants: [] });

      const yjsManager = client.yjs;
      if (yjsManager) {
        try {
          yjsManager.presenceManager.stopViewing(currentDocKey);
          yjsManager.documentManager.disconnect(currentDocKey);
        } catch {
          /* noop */
        }
      }

      setError(
        connectError instanceof Error
          ? connectError
          : new Error(String(connectError))
      );
    }
  }, [skip, client]);

  const disconnect = useCallback(() => {
    if (!isConnectedRef.current) {
      return;
    }

    try {
      setError(null);
      const yjsManager = client.yjs;
      const connectedDocKey = connectedDocKeyRef.current ?? docKeyRef.current;
      if (yjsManager) {
        yjsManager.presenceManager.stopViewing(connectedDocKey);
        yjsManager.documentManager.disconnect(connectedDocKey);
      }

      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      isConnectedRef.current = false;
      connectedDocKeyRef.current = null;
      setDoc(null);
      setContent("");
      setConnectionState("disconnected");
      setSessionState({ active: false, participants: [] });
    } catch (disconnectError) {
      setError(
        disconnectError instanceof Error
          ? disconnectError
          : new Error(String(disconnectError))
      );
    }
  }, [client]);

  useEffect(() => {
    const currentDocKeyString = toDocumentKeyString(docKey);
    const previousDocKeyString = previousDocKeyStringRef.current;

    if (currentDocKeyString === previousDocKeyString) {
      return;
    }

    previousDocKeyStringRef.current = currentDocKeyString;

    if (isConnectedRef.current) {
      disconnect();
    }

    if (autoConnect && !skip) {
      connect();
    }
  }, [docKey, autoConnect, skip, connect, disconnect]);

  const focus = useCallback(() => {
    if (skip) {
      return;
    }
    const yjsManager = client.yjs;
    if (!yjsManager) {
      return;
    }
    const focusDocKey = connectedDocKeyRef.current ?? docKeyRef.current;
    yjsManager.presenceManager.focus(focusDocKey);
  }, [client, skip]);

  const blur = useCallback(() => {
    if (skip) {
      return;
    }
    const yjsManager = client.yjs;
    if (!yjsManager) {
      return;
    }
    const blurDocKey = connectedDocKeyRef.current ?? docKeyRef.current;
    yjsManager.presenceManager.blur(blurDocKey);
  }, [client, skip]);

  // Auto-connect on mount if enabled
  useEffect(() => {
    if (autoConnect && !skip) {
      connect();
    }

    return () => {
      if (isConnectedRef.current) {
        disconnect();
      }
    };
  }, [autoConnect, skip, connect, disconnect]);

  return {
    blur,
    connect,
    connectionState,
    content,
    disconnect,
    doc,
    error,
    focus,
    isConnected: connectionState === "connected",
    isSessionActive: sessionState.active,
    participants: sessionState.participants,
  };
};
