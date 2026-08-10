import type { ConnectionState, SyncClientState } from "@stratasync/core";

import type { SyncClientEvent } from "../types.js";

/**
 * Owns the orchestrator's observable sync/connection state and last error,
 * plus the listener sets. Centralizes the invariant that any non-error state
 * transition clears the last error.
 */
export class SyncStateMachine {
  private _state: SyncClientState = "disconnected";
  private _connectionState: ConnectionState = "disconnected";
  private _lastError: Error | null = null;
  private _catchingUp = false;
  private readonly stateListeners = new Set<(state: SyncClientState) => void>();
  private readonly connectionListeners = new Set<
    (state: ConnectionState) => void
  >();
  private readonly emitEvent?: (event: SyncClientEvent) => void;

  constructor(emitEvent?: (event: SyncClientEvent) => void) {
    this.emitEvent = emitEvent;
  }

  get state(): SyncClientState {
    return this._state;
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  get lastError(): Error | null {
    return this._lastError;
  }

  /**
   * True while a multi-page delta backlog is being fetched and applied.
   *
   * Deliberately separate from `state`: the client is already `"syncing"` and
   * rendering cached data at this point, so readiness must not be gated on it.
   * It exists so apps can show a quiet indicator instead of the user inferring
   * "something is happening" from data moving underneath them.
   */
  get catchingUp(): boolean {
    return this._catchingUp;
  }

  setCatchingUp(catchingUp: boolean): void {
    if (this._catchingUp === catchingUp) {
      return;
    }
    this._catchingUp = catchingUp;
    this.emitEvent?.({ catchingUp, type: "catchUpChange" });
  }

  // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
  onStateChange(callback: (state: SyncClientState) => void): () => void {
    this.stateListeners.add(callback);
    return () => {
      this.stateListeners.delete(callback);
    };
  }

  onConnectionStateChange(
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback: (state: ConnectionState) => void
  ): () => void {
    this.connectionListeners.add(callback);
    return () => {
      this.connectionListeners.delete(callback);
    };
  }

  setState(state: SyncClientState): void {
    if (this._state === state) {
      return;
    }
    this._state = state;
    // Any non-error state clears the last error.
    if (state !== "error") {
      this._lastError = null;
    }
    this.emitEvent?.({ state, type: "stateChange" });
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }

  setConnectionState(state: ConnectionState): void {
    if (this._connectionState === state) {
      return;
    }
    this._connectionState = state;
    this.emitEvent?.({ state, type: "connectionChange" });
    for (const listener of this.connectionListeners) {
      listener(state);
    }
  }

  /**
   * Records a sync error: stores it, emits a `syncError` event, and transitions
   * to the `error` state.
   */
  recordError(error: unknown): void {
    this._lastError = error instanceof Error ? error : new Error(String(error));
    this.emitEvent?.({ error: this._lastError, type: "syncError" });
    this.setState("error");
  }

  clearError(): void {
    this._lastError = null;
  }
}
