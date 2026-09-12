import type {
  BatchLoadOptions,
  BootstrapMetadata,
  BootstrapOptions,
  ConnectionState,
  DeltaPacket,
  DeltaSubscription,
  ModelRow,
  MutateResult,
  SubscribeOptions,
  SyncId,
  TransactionBatch,
  TransactionResult,
} from "@stratasync/core";

import type { TransportAdapter } from "../types.js";
import { PacketStream } from "./packet-stream.js";

export type TransportErrorKind =
  | "network"
  | "unauthorized"
  | "bootstrapRequired"
  | "serverError";

export type TransportErrorTarget = "bootstrap" | "deltas" | "mutate";

export interface TransportCounts {
  bootstrapCount: number;
  deltaFetchCount: number;
  mutateCount: number;
  socketConnectCount: number;
}

interface QueuedBootstrap {
  rows: ModelRow[];
  metadata: BootstrapMetadata;
}

interface ParkedBatch {
  batch: TransactionBatch;
  verdicts: Map<string, TransactionResult>;
  resolve: (result: MutateResult) => void;
  reject: (error: unknown) => void;
}

/** Error codes the engine branches on; `BOOTSTRAP_REQUIRED` is the cursor-too-old signal. */
const ERROR_SHAPES: Record<
  TransportErrorKind,
  { code: string; message: string }
> = {
  bootstrapRequired: {
    code: "BOOTSTRAP_REQUIRED",
    message: "Cursor too old; a full bootstrap is required",
  },
  network: { code: "NETWORK_ERROR", message: "Network unreachable" },
  serverError: { code: "SERVER_ERROR", message: "Internal server error" },
  unauthorized: { code: "UNAUTHORIZED", message: "Not authorized" },
};

const makeError = (kind: TransportErrorKind): Error => {
  const shape = ERROR_SHAPES[kind];
  const error = new Error(shape.message) as Error & { code: string };
  error.code = shape.code;
  return error;
};

/**
 * The scripted {@link TransportAdapter} a conformance scenario drives.
 *
 * Every network effect is supplied by a step, never invented: bootstrap and
 * delta-fetch responses are queued ahead of time, socket packets are pushed,
 * and `mutate` parks until the scenario says whether the server accepted the
 * batch. Nothing here decides sync semantics — that is the engine's job.
 */
export class ScriptedTransport implements TransportAdapter {
  readonly counts: TransportCounts = {
    bootstrapCount: 0,
    deltaFetchCount: 0,
    mutateCount: 0,
    socketConnectCount: 0,
  };

  private readonly bootstrapQueue: QueuedBootstrap[] = [];
  private readonly deltaQueue: DeltaPacket[] = [];
  /** Packets delivered before the engine subscribed, or while the socket is down. */
  private pendingPackets: DeltaPacket[] = [];
  private stream: PacketStream | null = null;
  private socketConnected = false;
  private connectionState: ConnectionState = "connected";
  private readonly connectionListeners = new Set<
    (state: ConnectionState) => void
  >();

  private readonly armedErrors = new Map<TransportErrorTarget, Error>();
  private readonly parkedBatches: ParkedBatch[] = [];
  /** Verdicts that arrived before the batch carrying the transaction did. */
  private readonly earlyVerdicts = new Map<string, TransactionResult>();
  private lastSyncId: SyncId = "0";

  // --- scenario-facing controls -------------------------------------------

  queueBootstrap(rows: ModelRow[], metadata: BootstrapMetadata): void {
    this.bootstrapQueue.push({ metadata, rows });
  }

  queueDeltas(packet: DeltaPacket): void {
    this.deltaQueue.push(packet);
  }

  deliverDelta(packet: DeltaPacket): void {
    if (this.socketConnected && this.stream) {
      this.stream.push(packet);
      return;
    }
    this.pendingPackets.push(packet);
  }

  openSocket(): void {
    this.socketConnected = true;
    this.flushPendingPackets();
    this.setConnectionState("connected");
  }

  closeSocket(): void {
    this.socketConnected = false;
    this.stream?.end();
    this.stream = null;
    this.setConnectionState("disconnected");
  }

  armError(kind: TransportErrorKind, target: TransportErrorTarget): void {
    this.armedErrors.set(target, makeError(kind));
  }

  /** Resolves the parked `mutate` call once every transaction has a verdict. */
  settleMutation(clientTxId: string, result: TransactionResult): void {
    const parked = this.parkedBatches.find((entry) =>
      entry.batch.transactions.some((tx) => tx.clientTxId === clientTxId)
    );
    if (!parked) {
      this.earlyVerdicts.set(clientTxId, result);
      return;
    }
    parked.verdicts.set(clientTxId, result);
    this.resolveIfComplete(parked);
  }

  private resolveIfComplete(parked: ParkedBatch): void {
    const complete = parked.batch.transactions.every((tx) =>
      parked.verdicts.has(tx.clientTxId)
    );
    if (!complete) {
      return;
    }
    const index = this.parkedBatches.indexOf(parked);
    if (index !== -1) {
      this.parkedBatches.splice(index, 1);
    }
    const results = parked.batch.transactions.map(
      (tx) => parked.verdicts.get(tx.clientTxId) as TransactionResult
    );
    for (const result of results) {
      if (result.syncId && result.syncId > this.lastSyncId) {
        this.lastSyncId = result.syncId;
      }
    }
    parked.resolve({
      lastSyncId: this.lastSyncId,
      results,
      success: results.every((result) => result.success),
    });
  }

  private flushPendingPackets(): void {
    const { stream } = this;
    if (!stream) {
      return;
    }
    const packets = this.pendingPackets;
    this.pendingPackets = [];
    for (const packet of packets) {
      stream.push(packet);
    }
  }

  private setConnectionState(state: ConnectionState): void {
    if (this.connectionState === state) {
      return;
    }
    this.connectionState = state;
    for (const listener of this.connectionListeners) {
      listener(state);
    }
  }

  private takeError(target: TransportErrorTarget): Error | undefined {
    const error = this.armedErrors.get(target);
    if (error) {
      this.armedErrors.delete(target);
    }
    return error;
  }

  // --- TransportAdapter ----------------------------------------------------

  async *bootstrap(
    _options: BootstrapOptions
  ): AsyncGenerator<ModelRow, BootstrapMetadata, unknown> {
    this.counts.bootstrapCount += 1;
    const error = this.takeError("bootstrap");
    if (error) {
      throw error;
    }
    const response = this.bootstrapQueue.shift();
    if (!response) {
      throw new Error(
        "No bootstrap response queued — add a `respondBootstrap` step"
      );
    }
    for (const row of response.rows) {
      yield row;
    }
    if (response.metadata.lastSyncId) {
      this.lastSyncId = response.metadata.lastSyncId;
    }
    return response.metadata;
  }

  // oxlint-disable-next-line require-yield, class-methods-use-this -- batchLoad is unused by these scenarios
  async *batchLoad(_options: BatchLoadOptions): AsyncIterable<ModelRow> {
    await Promise.resolve();
  }

  mutate(batch: TransactionBatch): Promise<MutateResult> {
    this.counts.mutateCount += 1;
    const error = this.takeError("mutate");
    if (error) {
      return Promise.reject(error);
    }
    // oxlint-disable-next-line avoid-new -- the scenario resolves this later
    return new Promise<MutateResult>((resolve, reject) => {
      const parked: ParkedBatch = {
        batch,
        reject,
        resolve,
        verdicts: new Map(),
      };
      this.parkedBatches.push(parked);
      for (const tx of batch.transactions) {
        const early = this.earlyVerdicts.get(tx.clientTxId);
        if (early) {
          this.earlyVerdicts.delete(tx.clientTxId);
          parked.verdicts.set(tx.clientTxId, early);
        }
      }
      this.resolveIfComplete(parked);
    });
  }

  subscribe(_options: SubscribeOptions): DeltaSubscription {
    this.counts.socketConnectCount += 1;
    const stream = new PacketStream();
    this.stream = stream;
    if (this.socketConnected) {
      this.flushPendingPackets();
    }
    return {
      [Symbol.asyncIterator]: () => ({ next: () => stream.next() }),
      unsubscribe: () => {
        stream.end();
        if (this.stream === stream) {
          this.stream = null;
        }
      },
    };
  }

  fetchDeltas(after: SyncId): Promise<DeltaPacket> {
    this.counts.deltaFetchCount += 1;
    const error = this.takeError("deltas");
    if (error) {
      return Promise.reject(error);
    }
    const queued = this.deltaQueue.shift();
    return Promise.resolve(queued ?? { actions: [], lastSyncId: after });
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
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

  close(): Promise<void> {
    this.stream?.end();
    this.stream = null;
    return Promise.resolve();
  }
}
