import type {
  ConnectionState,
  DeltaPacket,
  ModelRegistry,
  SyncClientState,
  Transaction,
} from "@stratasync/core";

import type { IdentityMapRegistry } from "../identity-map.js";
import type { AsyncQueue } from "../internal/async-queue.js";
import type { Gate } from "../internal/gate.js";
import type { OutboxManager } from "../outbox-manager.js";
import type {
  StorageAdapter,
  SyncClientEvent,
  SyncClientOptions,
  TransportAdapter,
} from "../types.js";
import type { SyncCursor } from "./cursor.js";

/**
 * Shared collaborator + cross-cutting state surface that the orchestrator owns
 * and the extracted sync sub-modules (delta pipeline, bootstrap runner, sync
 * groups) operate against. The orchestrator is the single owner of the run
 * token, the delta subscription handle, the queues/gate, and the deferred
 * conflict list; the sub-modules read and mutate them only through this context
 * so the invariants (one run token, serialized packets, deferred rollbacks)
 * stay centralized.
 */
export interface SyncContext {
  readonly storage: StorageAdapter;
  readonly transport: TransportAdapter;
  readonly identityMaps: IdentityMapRegistry;
  readonly registry: ModelRegistry;
  readonly options: SyncClientOptions;
  readonly cursor: SyncCursor;
  readonly schemaHash: string;
  readonly emitEvent?: (event: SyncClientEvent) => void;

  readonly packetQueue: () => AsyncQueue;
  readonly stateQueue: () => AsyncQueue;
  readonly deltaReplayGate: () => Gate;

  getOutboxManager(): OutboxManager | null;
  getConflictHandler(): ((tx: Transaction) => void) | undefined;
  getClientId(): string;

  /** The active subscribed sync groups (mutable). */
  getGroups(): string[];
  setGroups(groups: string[]): void;

  /** The orchestrator's observed connection state (from the state machine). */
  getConnectionState(): ConnectionState;

  /** Whether the orchestrator's lifecycle is currently running. */
  isRunning(): boolean;
  /** The current run token. */
  getRunToken(): number;
  /** True while `running` and the run token still matches. */
  isRunActive(runToken: number): boolean;

  /** The live delta subscription iterator (shared between pipeline + groups). */
  getDeltaSubscription(): AsyncIterator<DeltaPacket> | null;
  setDeltaSubscription(subscription: AsyncIterator<DeltaPacket> | null): void;

  /** Conflict rollbacks deferred until the identity-map batch. */
  getDeferredConflictTxs(): Transaction[];
  setDeferredConflictTxs(txs: Transaction[]): void;

  setState(state: SyncClientState): void;
  recordError(error: unknown): void;

  /** Runs `operation` through the shared state queue. */
  runWithStateLock<T>(operation: () => Promise<T>): Promise<T>;
}
