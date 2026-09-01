import type { WebSocket } from "ws";

import { SyncId } from "../core/sync-id.js";
import type { ControlFrame } from "../delta/control-frames.js";
import type { DeltaSubscriberLike } from "../delta/delta-publisher.js";
import type { SyncActionOutput } from "../types.js";
import {
  buildDeltaFrame,
  buildErrorFrame,
  buildGroupJoinedFrame,
  buildGroupLeftFrame,
  GROUP_MEMBERSHIP_CAPABILITY,
} from "./messages.js";

export const MAX_BUFFERED_ACTIONS = 10_000;

export type SessionPhase = "idle" | "replaying" | "live" | "closed";

interface BufferedAction {
  action: SyncActionOutput;
  groups: string[];
}

const hasGroupOverlap = (
  clientGroups: string[],
  deltaGroups: string[]
): boolean => {
  if (deltaGroups.length === 0) {
    return true;
  }
  return clientGroups.some((group) => deltaGroups.includes(group));
};

/**
 * Per-connection sync state. A single `phase` replaces the five booleans the
 * legacy ClientState juggled, and the session owns the delta subscription so
 * close() can deterministically tear it down (fixes the subscription leak).
 */
export class ClientSession {
  phase: SessionPhase = "idle";
  userId: string | null = null;
  groups: string[] = [];
  /** Cursor as a bigint; serialized to the wire only at frame egress. */
  afterSyncId = 0n;

  private readonly socket: WebSocket;
  private readonly deltaSubscriber?: DeltaSubscriberLike;
  private unsubscribe: (() => void) | null = null;
  private controlUnsubscribe: (() => void) | null = null;
  private bufferedActions: BufferedAction[] = [];
  /**
   * Control frames held until replay finishes, keyed by group so a group that
   * churns during replay collapses to its final state. Bounding by distinct
   * group keeps this from growing with frame volume.
   */
  private bufferedControlFrames = new Map<string, ControlFrame>();
  /** Whether this client opted into server-initiated control frames. */
  private controlFramesEnabled = false;

  constructor(socket: WebSocket, deltaSubscriber?: DeltaSubscriberLike) {
    this.socket = socket;
    this.deltaSubscriber = deltaSubscriber;
  }

  get isClosed(): boolean {
    return this.phase === "closed";
  }

  /**
   * Resets to the unauthenticated idle state (used at the start of every
   * subscribe and when a subscribe attempt is rejected).
   */
  reset(): void {
    this.detach();
    this.phase = "idle";
    this.userId = null;
    this.groups = [];
    this.afterSyncId = 0n;
    this.bufferedActions = [];
    this.bufferedControlFrames = new Map();
    this.controlFramesEnabled = false;
  }

  /**
   * Begins a subscription: records identity/groups/cursor and enters the
   * replaying phase (live deltas are buffered until flush).
   *
   * `capabilities` are the strings the client declared on its subscribe frame.
   * A client that did not declare {@link GROUP_MEMBERSHIP_CAPABILITY} still has
   * membership changes applied to its delta scope — it just is not told about
   * them, because an unrecognized frame may read as a protocol error to it.
   */
  beginReplay(
    userId: string,
    groups: string[],
    afterSyncId: bigint,
    capabilities: readonly string[] = []
  ): void {
    this.userId = userId;
    this.groups = groups;
    this.afterSyncId = afterSyncId;
    this.phase = "replaying";
    this.bufferedActions = [];
    this.bufferedControlFrames = new Map();
    this.controlFramesEnabled = capabilities.includes(
      GROUP_MEMBERSHIP_CAPABILITY
    );
  }

  /**
   * Installs the live delta subscription. Guarded against installing on a
   * closed session, and immediately re-checks phase after install so a close
   * that raced the install still tears the subscription down.
   */
  installDeltaSubscription(): void {
    if (!this.deltaSubscriber || this.phase === "closed") {
      return;
    }

    this.unsubscribe = this.deltaSubscriber.onDelta(
      (action: SyncActionOutput, groups: string[]) => {
        this.onLiveDelta(action, groups);
      }
    );

    // Defense against a close that raced the install: if the session closed
    // while we were installing, tear the subscription down immediately so the
    // bus callback never leaks.
    if (this.isClosed) {
      this.detach();
    }
  }

  /**
   * Installs the server-initiated control frame subscription. Same close-race
   * guard as {@link ClientSession.installDeltaSubscription}; a no-op when the
   * subscriber predates control frames and has no `onControl`.
   */
  installControlSubscription(): void {
    if (!this.deltaSubscriber?.onControl || this.phase === "closed") {
      return;
    }

    this.controlUnsubscribe = this.deltaSubscriber.onControl(
      (frame: ControlFrame) => {
        this.onControlFrame(frame);
      }
    );

    if (this.isClosed) {
      this.detach();
    }
  }

  /**
   * Applies a control frame addressed to this session's user.
   *
   * The membership edit is applied to `groups` without re-authorizing: only the
   * server publishes these frames, and it does so because it just changed the
   * membership itself. Joining starts live delivery for the new group
   * immediately; leaving stops it, which is what keeps a removed member from
   * seeing subsequent edits without waiting for a reconnect.
   */
  private onControlFrame(frame: ControlFrame): void {
    if (this.phase === "closed" || this.phase === "idle") {
      return;
    }

    if (frame.userId !== this.userId) {
      return;
    }

    if (frame.type === "group_joined") {
      if (!this.groups.includes(frame.groupId)) {
        this.groups.push(frame.groupId);
      }
    } else {
      this.groups = this.groups.filter((group) => group !== frame.groupId);
    }

    if (this.phase === "replaying") {
      this.bufferedControlFrames.set(frame.groupId, frame);
      return;
    }

    this.sendControlFrame(frame);
  }

  private sendControlFrame(frame: ControlFrame): void {
    // The membership edit above always applies — stopping delivery to a removed
    // member is a security boundary, not an optimisation. Only telling the
    // client is gated, because a client that predates control frames may treat
    // an unrecognized frame as a protocol error and drop the connection.
    if (!this.controlFramesEnabled) {
      return;
    }

    if (this.socket.readyState !== this.socket.OPEN) {
      return;
    }

    this.socket.send(
      frame.type === "group_joined"
        ? buildGroupJoinedFrame(frame.groupId)
        : buildGroupLeftFrame(frame.groupId)
    );
  }

  private onLiveDelta(action: SyncActionOutput, groups: string[]): void {
    if (this.phase === "closed") {
      return;
    }

    if (!hasGroupOverlap(this.groups, groups)) {
      return;
    }

    if (SyncId.parse(action.syncId) <= this.afterSyncId) {
      return;
    }

    if (this.phase === "replaying") {
      this.bufferLiveDelta(action, groups);
      return;
    }

    this.sendDeltaAction(action);
  }

  private bufferLiveDelta(action: SyncActionOutput, groups: string[]): void {
    if (this.bufferedActions.length >= MAX_BUFFERED_ACTIONS) {
      this.overflow();
      return;
    }
    this.bufferedActions.push({ action, groups });
  }

  private overflow(): void {
    this.detach();
    this.phase = "closed";
    this.bufferedActions = [];
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(
        buildErrorFrame("Replay buffer limit exceeded", "BUFFER_OVERFLOW")
      );
      this.socket.close(4008, "Replay buffer limit exceeded");
    }
  }

  /**
   * Sends a single action if it advances the cursor, then advances it. Used by
   * both replay and live delivery.
   */
  sendDeltaAction(action: SyncActionOutput): void {
    if (this.phase === "closed") {
      return;
    }

    const syncId = SyncId.parse(action.syncId);
    if (syncId <= this.afterSyncId) {
      return;
    }

    this.afterSyncId = syncId;

    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(buildDeltaFrame(action, action.syncId));
    }
  }

  /**
   * Transitions replaying -> live: sorts the buffer ascending, dedupes
   * first-wins by syncId, re-checks group overlap, and delivers each.
   */
  flushBufferedActions(): void {
    this.phase = "live";

    const sorted = this.bufferedActions.toSorted((left, right) =>
      SyncId.compare(
        SyncId.parse(left.action.syncId),
        SyncId.parse(right.action.syncId)
      )
    );

    const seenSyncIds = new Set<string>();
    for (const entry of sorted) {
      if (seenSyncIds.has(entry.action.syncId)) {
        continue;
      }
      seenSyncIds.add(entry.action.syncId);

      if (!hasGroupOverlap(this.groups, entry.groups)) {
        continue;
      }

      this.sendDeltaAction(entry.action);
    }

    this.bufferedActions = [];

    for (const frame of this.bufferedControlFrames.values()) {
      this.sendControlFrame(frame);
    }
    this.bufferedControlFrames = new Map();
  }

  /** Tears down the delta and control subscriptions without changing phase. */
  private detach(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.controlUnsubscribe) {
      this.controlUnsubscribe();
      this.controlUnsubscribe = null;
    }
  }

  /** Terminal close: marks closed and unsubscribes from the delta bus. */
  close(): void {
    this.phase = "closed";
    this.detach();
  }
}
