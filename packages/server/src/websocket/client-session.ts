import type { WebSocket } from "ws";

import {
  BOOTSTRAP_REQUIRED,
  BOOTSTRAP_REQUIRED_WS_MESSAGE,
  isSyncCursorStale,
} from "../core/errors.js";
import { toSyncActionOutput } from "../core/sync-action.js";
import { SYNC_GROUPS_ACTION, SYNC_GROUPS_MODEL } from "../core/sync-groups.js";
import { SyncId } from "../core/sync-id.js";
import type { SyncDao } from "../dao/sync-dao.js";
import type { DeltaSubscriberLike } from "../delta/delta-publisher.js";
import type { SyncActionOutput, SyncUserContext } from "../types.js";
import type { AsyncMutex } from "../utils/async-mutex.js";
import { buildDeltaFrame, buildErrorFrame } from "./messages.js";

export const MAX_BUFFERED_ACTIONS = 10_000;

const GAP_FILL_PAGE_SIZE = 1000;

export type SessionPhase = "idle" | "replaying" | "live" | "closed";

interface BufferedAction {
  action: SyncActionOutput;
  groups: string[];
}

type ReauthorizeDelivery = (token: string) => Promise<SyncUserContext | null>;

interface ClientSessionOptions {
  deliveryMutex: AsyncMutex;
  /**
   * Reads the committed ids a live delta skipped over. Without it a live
   * delta that arrives ahead of a lower id (possible whenever more than one
   * process publishes) advances the cursor past that id for good.
   */
  gapFillDao?: SyncDao;
  groupRefreshGuardDao?: SyncDao;
  reauthorizeDelivery?: ReauthorizeDelivery;
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

const isSyncGroupsAction = (action: SyncActionOutput): boolean =>
  action.action === SYNC_GROUPS_ACTION &&
  action.modelName === SYNC_GROUPS_MODEL;

/**
 * Per-connection sync state. A single `phase` replaces the five booleans the
 * legacy ClientState juggled, and the session owns the delta subscription so
 * close() can deterministically tear it down (fixes the subscription leak).
 */
export class ClientSession {
  phase: SessionPhase = "idle";
  userId: string | null = null;
  groups: string[] = [];
  principal: unknown = undefined;
  /** Cursor as a bigint; serialized to the wire only at frame egress. */
  afterSyncId = 0n;
  /**
   * Every committed id at or below this one that this session may see has
   * been sent (or deliberately filtered). Always `>= afterSyncId`. Live deltas
   * are only notifications: one above `scannedThrough + 1` first has the ids
   * between read from `sync_actions`, so it can never carry the cursor past a
   * committed id that is still in flight on another process's publish path.
   *
   * Sound because `SyncDao.createSyncAction` allocates ids under a
   * transaction-scoped advisory lock (with the default sequence CACHE 1): once
   * id `d` is committed, every lower id that will ever commit is already
   * visible, and ids that were rolled back never will be. See
   * `verification/lean/StrataSync/Server.lean` §9.
   */
  scannedThrough = 0n;

  private readonly socket: WebSocket;
  private readonly deltaSubscriber?: DeltaSubscriberLike;
  private readonly deliveryMutex: AsyncMutex;
  private readonly gapFillDao?: SyncDao;
  private readonly groupRefreshGuardDao?: SyncDao;
  private readonly reauthorizeDelivery?: ReauthorizeDelivery;
  private unsubscribe: (() => void) | null = null;
  private bufferedActions: BufferedAction[] = [];
  private groupRefreshCursor = 0n;
  private token: string | null = null;

  constructor(
    socket: WebSocket,
    deltaSubscriber: DeltaSubscriberLike | undefined,
    options: ClientSessionOptions
  ) {
    this.socket = socket;
    this.deltaSubscriber = deltaSubscriber;
    this.deliveryMutex = options.deliveryMutex;
    this.gapFillDao = options.gapFillDao;
    this.groupRefreshGuardDao = options.groupRefreshGuardDao;
    this.reauthorizeDelivery = options.reauthorizeDelivery;
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
    this.principal = undefined;
    this.afterSyncId = 0n;
    this.scannedThrough = 0n;
    this.bufferedActions = [];
    this.groupRefreshCursor = 0n;
    this.token = null;
  }

  /**
   * Begins a subscription: records identity/groups/cursor and enters the
   * replaying phase (live deltas are buffered until flush).
   */
  beginReplay(
    userId: string,
    groups: string[],
    afterSyncId: bigint,
    token: string,
    principal?: unknown
  ): void {
    this.userId = userId;
    this.groups = groups;
    this.principal = principal;
    this.afterSyncId = afterSyncId;
    this.scannedThrough = afterSyncId;
    this.groupRefreshCursor = afterSyncId;
    this.token = token;
    this.phase = "replaying";
    this.bufferedActions = [];
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
      async (action: SyncActionOutput, groups: string[]) => {
        await this.onLiveDelta(action, groups);
      }
    );

    // Defense against a close that raced the install: if the session closed
    // while we were installing, tear the subscription down immediately so the
    // bus callback never leaks.
    if (this.isClosed) {
      this.detach();
    }
  }

  private async onLiveDelta(
    action: SyncActionOutput,
    groups: string[]
  ): Promise<void> {
    if (this.phase === "closed") {
      return;
    }

    // Safe to drop outside the mutex: the cursor only grows, and every id at
    // or below it is already covered.
    if (SyncId.parse(action.syncId) <= this.afterSyncId) {
      return;
    }

    if (this.phase === "replaying") {
      if (hasGroupOverlap(this.groups, groups)) {
        this.bufferLiveDelta(action, groups);
      }
      return;
    }

    try {
      // Every delta, including ones for other groups, is ordered through the
      // mutex so that a contiguous foreign id can advance `scannedThrough`
      // and spare the next delivery a gap-fill read.
      await this.deliveryMutex.runExclusive(async () => {
        if (this.phase === "live") {
          await this.deliverLiveDelta(action, groups);
        }
      });
    } catch {
      this.failLiveDelivery();
    }
  }

  /**
   * Delivers one live (or buffered) delta. Must run under the delivery mutex.
   * A delta for a group this session does not hold is not sent, but when it
   * is the very next id it still proves nothing lies between, so the scan
   * horizon moves past it.
   */
  private async deliverLiveDelta(
    action: SyncActionOutput,
    groups: string[]
  ): Promise<void> {
    const syncId = SyncId.parse(action.syncId);
    if (syncId <= this.scannedThrough) {
      return;
    }

    if (!hasGroupOverlap(this.groups, groups)) {
      if (syncId === this.scannedThrough + 1n) {
        this.scannedThrough = syncId;
      }
      return;
    }

    await this.sendDeltaAction(action);
  }

  /**
   * Decides whether `syncId` is still to be handled and, if so, first sends
   * every lower committed id this session has not seen (unless the caller
   * already read up to it), then records `syncId` as scanned.
   */
  private async claimSyncId(
    syncId: bigint,
    scanned: boolean
  ): Promise<boolean> {
    // `afterSyncId <= scannedThrough` always, so this also drops anything at
    // or below the cursor.
    if (syncId <= this.scannedThrough) {
      return false;
    }
    if (!scanned && syncId > this.scannedThrough + 1n) {
      await this.fillGapBefore(syncId);
      if (this.isClosed || syncId <= this.scannedThrough) {
        return false;
      }
    }
    this.scannedThrough = syncId;
    return true;
  }

  /**
   * Reads and sends every committed id in `(scannedThrough, syncId)` visible to
   * this session, in id order, then records the window as scanned.
   */
  private async fillGapBefore(syncId: bigint): Promise<void> {
    const syncDao = this.gapFillDao;
    const throughSyncId = syncId - 1n;
    if (syncDao) {
      let cursor = this.scannedThrough;
      while (!this.isClosed && cursor < throughSyncId) {
        const actions = await syncDao.getSyncActionsThrough(
          cursor,
          throughSyncId,
          this.groups,
          GAP_FILL_PAGE_SIZE
        );
        for (const action of actions) {
          await this.sendDeltaAction(toSyncActionOutput(action), {
            scanned: true,
          });
          if (this.isClosed) {
            return;
          }
        }
        const lastAction = actions.at(-1);
        if (!lastAction || actions.length < GAP_FILL_PAGE_SIZE) {
          break;
        }
        cursor = lastAction.id;
      }
    }

    if (!this.isClosed && throughSyncId > this.scannedThrough) {
      this.scannedThrough = throughSyncId;
    }
  }

  /**
   * A live delivery (typically the gap-fill read) failed. Close the socket so
   * the client resubscribes from the cursor it actually holds rather than
   * silently stalling.
   */
  private failLiveDelivery(): void {
    this.bufferedActions = [];
    this.detach();
    this.phase = "closed";
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.close(1011, "Live delivery failed");
    }
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
   * replay, gap fill, buffer flush, live delivery and group-refresh catch-up.
   *
   * `scanned` means the caller read `sync_actions` contiguously up to this id
   * (replay and gap fill); anything else is a notification that may have
   * overtaken lower ids, so those are read first.
   */
  async sendDeltaAction(
    action: SyncActionOutput,
    options: { scanned?: boolean } = {}
  ): Promise<void> {
    if (this.phase === "closed") {
      return;
    }

    const syncId = SyncId.parse(action.syncId);
    if (!(await this.claimSyncId(syncId, options.scanned === true))) {
      return;
    }

    const authorizedGroups = action.groupId
      ? await this.reauthorizeProtectedDelivery()
      : undefined;
    if (this.isClosed || authorizedGroups === null) {
      return;
    }

    if (action.groupId && !this.groups.includes(action.groupId)) {
      return;
    }

    if (
      !isSyncGroupsAction(action) &&
      !(await this.guardGroupRefreshCursor(syncId))
    ) {
      return;
    }

    if (isSyncGroupsAction(action)) {
      const latestGroups = Array.isArray(action.data.subscribedSyncGroups)
        ? action.data.subscribedSyncGroups.filter(
            (group): group is string => typeof group === "string"
          )
        : [];
      const latestGroupSet = new Set(latestGroups);
      this.groups = this.groups.filter((group) => latestGroupSet.has(group));
    }

    if (this.socket.readyState === this.socket.OPEN) {
      const scopedAction = isSyncGroupsAction(action)
        ? {
            ...action,
            data: {
              subscribedSyncGroups: authorizedGroups ?? [...this.groups],
            },
          }
        : action;
      if (syncId > this.afterSyncId) {
        this.afterSyncId = syncId;
      }
      if (isSyncGroupsAction(action) && syncId > this.groupRefreshCursor) {
        this.groupRefreshCursor = syncId;
      }
      this.socket.send(
        buildDeltaFrame(scopedAction, SyncId.serialize(this.afterSyncId))
      );
    }
  }

  /**
   * Prevents an ordinary frame from advancing the main cursor past a durable
   * group refresh that this socket missed on the live transport.
   */
  private async guardGroupRefreshCursor(
    throughSyncId: bigint
  ): Promise<boolean> {
    const { groupRefreshGuardDao: syncDao, userId } = this;
    if (!(syncDao && userId) || throughSyncId <= this.groupRefreshCursor) {
      return true;
    }

    try {
      const earliestSyncId = await syncDao.getEarliestSyncId();
      if (isSyncCursorStale(this.groupRefreshCursor, earliestSyncId)) {
        this.requireBootstrap();
        return false;
      }

      const [missedRefresh] = await syncDao.getSyncGroupActions(
        this.groupRefreshCursor,
        throughSyncId,
        userId,
        1
      );
      if (missedRefresh) {
        this.requireBootstrap();
        return false;
      }

      this.groupRefreshCursor = throughSyncId;
      return true;
    } catch {
      this.requireBootstrap();
      return false;
    }
  }

  /**
   * Scans a stable durable prefix for personal group refreshes missed by the
   * live transport. Uses a cursor independent of ordinary delta delivery so a
   * later live action cannot hide an earlier missed G action.
   */
  async catchUpGroupRefreshActions(syncDao: SyncDao): Promise<void> {
    if (this.phase !== "live" || !this.userId) {
      return;
    }

    const earliestSyncId = await syncDao.getEarliestSyncId();
    if (isSyncCursorStale(this.groupRefreshCursor, earliestSyncId)) {
      this.requireBootstrap();
      return;
    }

    const throughSyncId = await syncDao.getLastSyncIdForGroups([this.userId]);
    if (throughSyncId <= this.groupRefreshCursor) {
      return;
    }

    const pageSize = 100;
    let cursor = this.groupRefreshCursor;
    while (!this.isClosed && cursor < throughSyncId) {
      const actions = await syncDao.getSyncGroupActions(
        cursor,
        throughSyncId,
        this.userId,
        pageSize
      );
      for (const action of actions) {
        if (action.id <= this.afterSyncId) {
          this.requireBootstrap();
          return;
        }
        await this.sendDeltaAction(toSyncActionOutput(action));
        if (this.isClosed) {
          return;
        }
      }
      if (actions.length < pageSize) {
        break;
      }
      const lastAction = actions.at(-1);
      if (!lastAction) {
        break;
      }
      cursor = lastAction.id;
    }

    this.groupRefreshCursor = throughSyncId;
  }

  /** Freshly authorizes the final subscribed acknowledgement when enabled. */
  async authorizeSubscribedFrame(): Promise<boolean> {
    const authorizedGroups = await this.reauthorizeProtectedDelivery();
    return authorizedGroups !== null && !this.isClosed;
  }

  private async reauthorizeProtectedDelivery(): Promise<
    string[] | null | undefined
  > {
    if (!this.reauthorizeDelivery) {
      return undefined;
    }

    const { token, userId: expectedUserId } = this;
    if (!(token && expectedUserId)) {
      this.failDeliveryAuthorization();
      return null;
    }

    const authorized = await this.reauthorizeDelivery(token);
    if (this.isClosed || this.socket.readyState !== this.socket.OPEN) {
      return null;
    }
    if (!authorized || authorized.userId !== expectedUserId) {
      this.failDeliveryAuthorization();
      return null;
    }

    const allowedGroups = new Set(authorized.groups);
    this.groups = this.groups.filter((group) => allowedGroups.has(group));
    this.principal = authorized.principal;
    return [...allowedGroups];
  }

  private failDeliveryAuthorization(): void {
    this.groups = [];
    this.principal = undefined;
    this.bufferedActions = [];
    this.detach();
    this.phase = "closed";
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(
        buildErrorFrame(
          "WebSocket delivery authorization failed",
          "ACCESS_DENIED"
        )
      );
      this.socket.close(4003, "WebSocket delivery authorization failed");
    }
  }

  private requireBootstrap(): void {
    this.groups = [];
    this.bufferedActions = [];
    this.detach();
    this.phase = "closed";
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(
        buildErrorFrame(BOOTSTRAP_REQUIRED_WS_MESSAGE, BOOTSTRAP_REQUIRED)
      );
      this.socket.close(4009, BOOTSTRAP_REQUIRED_WS_MESSAGE);
    }
  }

  /**
   * Transitions replaying -> live: sorts the buffer ascending, dedupes
   * first-wins by syncId, and delivers each exactly as a live delta (group
   * overlap re-checked, gaps filled from `sync_actions`). Runs under the
   * delivery mutex, held by the subscribe handler.
   */
  async flushBufferedActions(): Promise<void> {
    const seenSyncIds = new Set<string>();
    while (this.bufferedActions.length > 0 && !this.isClosed) {
      const pending = this.bufferedActions;
      this.bufferedActions = [];
      const sorted = pending.toSorted((left, right) =>
        SyncId.compare(
          SyncId.parse(left.action.syncId),
          SyncId.parse(right.action.syncId)
        )
      );

      for (const entry of sorted) {
        if (seenSyncIds.has(entry.action.syncId)) {
          continue;
        }
        seenSyncIds.add(entry.action.syncId);

        await this.deliverLiveDelta(entry.action, entry.groups);
      }
    }

    if (!this.isClosed) {
      this.phase = "live";
    }
  }

  /** Tears down the delta subscription without changing phase. */
  private detach(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /** Terminal close: marks closed and unsubscribes from the delta bus. */
  close(): void {
    this.phase = "closed";
    this.detach();
  }
}
