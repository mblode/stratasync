// oxlint-disable no-use-before-define -- helper functions and class methods reference later-defined utilities
/**
 * YjsPresenceManager - Manages presence signaling for collaborative editing.
 *
 * Responsibilities:
 * - Track which documents the user is viewing
 * - Signal focus/blur state to the server
 * - Track session state (active, participants)
 * - Provide callbacks for session state changes
 */

import { calculateRetryDelay, normalizeRetryConfig } from "./retry.js";
import type {
  DocumentKey,
  LiveEditingErrorMessage,
  LiveEditingRetryConfig,
  ServerMessage,
  SessionState,
  SessionStateMessage,
  YjsTransport,
  YjsTransportConnectionState,
} from "./types.js";
import {
  fromDocumentKeyString,
  isLiveEditingErrorMessage,
  isRetryableLiveEditingErrorCode,
  isSessionStateMessage,
  toDocumentKeyString,
} from "./types.js";

interface PresenceState {
  isViewing: boolean;
  isEditing: boolean;
  sessionState: SessionState | null;
  retryAttempts: number;
  retryTimer?: ReturnType<typeof setTimeout>;
}

interface PresenceManagerConfig {
  clientId: string;
  connId: string;
  liveEditingRetry?: Partial<LiveEditingRetryConfig>;
}

/**
 * Manages presence signaling for collaborative editing.
 */
export class YjsPresenceManager {
  private readonly presenceStates = new Map<string, PresenceState>();
  private readonly config: PresenceManagerConfig;
  private readonly liveEditingRetryConfig: LiveEditingRetryConfig;
  private transport: YjsTransport | null = null;
  private transportConnectionState: YjsTransportConnectionState =
    "disconnected";
  private unsubscribeTransportMessage: (() => void) | null = null;
  private unsubscribeTransportConnection: (() => void) | null = null;
  private readonly sessionStateCallbacks = new Map<
    string,
    Set<(state: SessionState) => void>
  >();

  constructor(config: PresenceManagerConfig) {
    this.config = config;
    this.liveEditingRetryConfig = normalizeRetryConfig(config.liveEditingRetry);
  }

  setTransport(transport: YjsTransport): void {
    this.unsubscribeTransportMessage?.();
    this.unsubscribeTransportConnection?.();
    this.transport = transport;
    this.transportConnectionState = "disconnected";

    this.unsubscribeTransportMessage = transport.onMessage((message) => {
      this.handleMessage(message);
    });
    this.unsubscribeTransportConnection = transport.onConnectionStateChange(
      (state) => {
        this.handleTransportConnectionStateChange(state);
      }
    );

    this.handleTransportConnectionStateChange(
      transport.isConnected() ? "connected" : "disconnected"
    );
  }

  /**
   * Start viewing a document.
   * This signals to the server that the user has opened the document.
   */
  startViewing(docKey: DocumentKey): void {
    const keyString = toDocumentKeyString(docKey);
    let state = this.presenceStates.get(keyString);

    if (!state) {
      state = {
        isEditing: false,
        isViewing: false,
        retryAttempts: 0,
        sessionState: null,
      };
      this.presenceStates.set(keyString, state);
    }

    if (state.isViewing) {
      return;
    }

    state.isViewing = true;
    YjsPresenceManager.resetRetryState(state);

    this.sendDocView(docKey, "start");
  }

  /**
   * Stop viewing a document.
   * This signals to the server that the user has closed the document.
   */
  stopViewing(docKey: DocumentKey): void {
    const keyString = toDocumentKeyString(docKey);
    const state = this.presenceStates.get(keyString);

    if (!state?.isViewing) {
      return;
    }

    if (state.isEditing) {
      this.blur(docKey);
    }

    state.isViewing = false;
    YjsPresenceManager.resetRetryState(state);

    this.sendDocView(docKey, "stop");

    state.sessionState = null;
    this.presenceStates.delete(keyString);
    this.pruneSessionStateCallbacks(keyString);
  }

  /**
   * Signal that the user has focused the editor.
   * This indicates active editing intent.
   */
  focus(docKey: DocumentKey): void {
    const keyString = toDocumentKeyString(docKey);

    if (!this.presenceStates.get(keyString)?.isViewing) {
      this.startViewing(docKey);
    }

    const state = this.presenceStates.get(keyString);
    if (!state || state.isEditing) {
      return;
    }

    state.isEditing = true;

    this.sendDocFocus(docKey, "focus");
  }

  /**
   * Signal that the user has blurred the editor.
   * This indicates the user is no longer actively editing.
   */
  blur(docKey: DocumentKey): void {
    const keyString = toDocumentKeyString(docKey);
    const state = this.presenceStates.get(keyString);

    if (!state?.isEditing) {
      return;
    }

    state.isEditing = false;

    this.sendDocFocus(docKey, "blur");
  }

  isViewing(docKey: DocumentKey): boolean {
    const keyString = toDocumentKeyString(docKey);
    return this.presenceStates.get(keyString)?.isViewing ?? false;
  }

  isEditing(docKey: DocumentKey): boolean {
    const keyString = toDocumentKeyString(docKey);
    return this.presenceStates.get(keyString)?.isEditing ?? false;
  }

  getSessionState(docKey: DocumentKey): SessionState | null {
    const keyString = toDocumentKeyString(docKey);
    return this.presenceStates.get(keyString)?.sessionState ?? null;
  }

  onSessionStateChange(
    docKey: DocumentKey,
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback: (state: SessionState) => void
  ): () => void {
    const keyString = toDocumentKeyString(docKey);
    let callbacks = this.sessionStateCallbacks.get(keyString);

    if (!callbacks) {
      callbacks = new Set();
      this.sessionStateCallbacks.set(keyString, callbacks);
    }

    callbacks.add(callback);

    const currentState = this.getSessionState(docKey);
    if (currentState) {
      // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
      callback(currentState);
    }

    return () => {
      callbacks?.delete(callback);
      if (callbacks?.size === 0) {
        this.sessionStateCallbacks.delete(keyString);
      }
    };
  }

  cleanup(): void {
    for (const [keyString] of this.presenceStates) {
      const docKey = fromDocumentKeyString(keyString);
      if (docKey) {
        this.stopViewing(docKey);
      }
    }

    this.presenceStates.clear();
    this.sessionStateCallbacks.clear();
  }

  private handleTransportConnectionStateChange(
    state: YjsTransportConnectionState
  ): void {
    const wasConnected = this.transportConnectionState === "connected";
    const isConnected = state === "connected";
    this.transportConnectionState = state;

    if (isConnected && !wasConnected) {
      this.resetAllRetryState();
      this.replayActivePresenceState();
    }
  }

  private replayActivePresenceState(): void {
    for (const [keyString, state] of this.presenceStates) {
      if (!state.isViewing) {
        continue;
      }
      const docKey = fromDocumentKeyString(keyString);
      if (!docKey) {
        continue;
      }

      this.sendDocView(docKey, "start");
      if (state.isEditing) {
        this.sendDocFocus(docKey, "focus");
      }
    }
  }

  private static clearRetryTimer(state: PresenceState): void {
    if (state.retryTimer !== undefined) {
      clearTimeout(state.retryTimer);
      state.retryTimer = undefined;
    }
  }

  private static resetRetryState(state: PresenceState): void {
    YjsPresenceManager.clearRetryTimer(state);
    state.retryAttempts = 0;
  }

  private resetAllRetryState(): void {
    for (const state of this.presenceStates.values()) {
      YjsPresenceManager.resetRetryState(state);
    }
  }

  private pruneSessionStateCallbacks(keyString: string): void {
    const callbacks = this.sessionStateCallbacks.get(keyString);
    if (callbacks?.size === 0) {
      this.sessionStateCallbacks.delete(keyString);
    }
  }

  private schedulePresenceReplay(
    keyString: string,
    state: PresenceState
  ): void {
    if (!state.isViewing) {
      return;
    }

    if (state.retryTimer !== undefined) {
      return;
    }

    if (state.retryAttempts >= this.liveEditingRetryConfig.maxRetries) {
      YjsPresenceManager.resetRetryState(state);
      return;
    }

    const retryDelayMs = calculateRetryDelay(
      state.retryAttempts,
      this.liveEditingRetryConfig
    );
    state.retryAttempts += 1;
    state.retryTimer = setTimeout(() => {
      const currentState = this.presenceStates.get(keyString);
      if (!currentState) {
        return;
      }

      currentState.retryTimer = undefined;
      if (!currentState.isViewing) {
        return;
      }

      const docKey = fromDocumentKeyString(keyString);
      if (!docKey) {
        return;
      }

      this.sendDocView(docKey, "start");
      if (currentState.isEditing) {
        this.sendDocFocus(docKey, "focus");
      }
    }, retryDelayMs);
  }

  private sendDocView(docKey: DocumentKey, state: "start" | "stop"): void {
    if (!this.transport?.isConnected()) {
      return;
    }

    this.transport.send({
      clientId: this.config.clientId,
      connId: this.config.connId,
      entityId: docKey.entityId,
      entityType: docKey.entityType,
      fieldName: docKey.fieldName,
      state,
      type: "doc_view",
    });
  }

  private sendDocFocus(docKey: DocumentKey, state: "focus" | "blur"): void {
    if (!this.transport?.isConnected()) {
      return;
    }

    this.transport.send({
      clientId: this.config.clientId,
      connId: this.config.connId,
      entityId: docKey.entityId,
      entityType: docKey.entityType,
      fieldName: docKey.fieldName,
      state,
      type: "doc_focus",
    });
  }

  private handleMessage(message: ServerMessage): void {
    if (isSessionStateMessage(message)) {
      this.handleSessionState(message);
    } else if (isLiveEditingErrorMessage(message)) {
      this.handleError(message);
    }
  }

  private handleSessionState(message: SessionStateMessage): void {
    const keyString = toDocumentKeyString(message);
    const state = this.presenceStates.get(keyString);

    if (!state) {
      return;
    }

    YjsPresenceManager.resetRetryState(state);

    const sessionState: SessionState = {
      active: message.active,
      participants: message.participants,
    };

    state.sessionState = sessionState;

    const callbacks = this.sessionStateCallbacks.get(keyString);
    if (callbacks) {
      for (const callback of callbacks) {
        // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
        callback(sessionState);
      }
    }
  }

  private handleError(message: LiveEditingErrorMessage): void {
    const keyString = toDocumentKeyString(message);
    const state = this.presenceStates.get(keyString);

    if (!state) {
      return;
    }

    if (!isRetryableLiveEditingErrorCode(message.code)) {
      YjsPresenceManager.resetRetryState(state);
      return;
    }

    this.schedulePresenceReplay(keyString, state);
  }
}
