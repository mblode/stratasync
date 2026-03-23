import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";

import type { SyncAuthConfig, SyncLogger, WebSocketHooks } from "../config.js";
import { noopLogger } from "../config.js";
import type { SyncDao } from "../dao/sync-dao.js";
import type { DeltaSubscriberLike } from "../delta/delta-publisher.js";
import { safeJsonStringify } from "../delta/delta-publisher.js";
import type { SyncActionOutput } from "../types.js";
import { AsyncMutex } from "../utils/async-mutex.js";
import {
  dedupeSyncGroups,
  resolveRequestedSyncGroups,
} from "../utils/sync-scope.js";
import {
  parseSyncIdString,
  serializeSyncId,
  toSyncActionOutput,
} from "../utils/sync-utils.js";

interface SubscribeMessage {
  type: "subscribe";
  afterSyncId: string;
  token: string;
  groups?: string[];
}

interface DeltaMessage {
  type: "delta";
  packet: {
    lastSyncId: string;
    actions: {
      syncId: string;
      modelName: string;
      modelId: string;
      action: string;
      data: unknown;
      groupId?: string;
      clientTxId?: string;
      clientId?: string;
      createdAt: string;
    }[];
  };
}

interface ClientState {
  authenticated: boolean;
  closed: boolean;
  userId: string | null;
  groups: string[];
  afterSyncId: string;
  unsubscribe: (() => void) | null;
  replaying: boolean;
  bufferedActions: {
    action: SyncActionOutput;
    groups: string[];
  }[];
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_BUFFERED_ACTIONS = 10_000;
const NON_NEGATIVE_INTEGER_REGEX = /^\d+$/;

const hasGroupOverlap = (
  clientGroups: string[],
  deltaGroups: string[]
): boolean => {
  if (deltaGroups.length === 0) {
    return true;
  }
  return clientGroups.some((group) => deltaGroups.includes(group));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNonNegativeIntegerString = (value: string): boolean =>
  NON_NEGATIVE_INTEGER_REGEX.test(value);

const isSubscribeMessage = (msg: unknown): msg is SubscribeMessage => {
  if (typeof msg !== "object" || msg === null) {
    return false;
  }
  const record = msg as Record<string, unknown>;
  if (record.type !== "subscribe") {
    return false;
  }
  if (typeof record.token !== "string") {
    return false;
  }
  const { afterSyncId } = record;
  const { groups } = record;
  const groupsValid =
    groups === undefined ||
    (Array.isArray(groups) &&
      groups.every((group) => typeof group === "string"));
  if (!groupsValid) {
    return false;
  }
  return (
    afterSyncId === undefined ||
    (typeof afterSyncId === "string" && isNonNegativeIntegerString(afterSyncId))
  );
};

const compareSyncActionOutput = (
  left: SyncActionOutput,
  right: SyncActionOutput
): number => {
  const leftId = parseSyncIdString(left.syncId);
  const rightId = parseSyncIdString(right.syncId);
  if (leftId === rightId) {
    return 0;
  }
  return leftId < rightId ? -1 : 1;
};

const unsubscribeClient = (state: ClientState): void => {
  if (!state.unsubscribe) {
    return;
  }
  state.unsubscribe();
  state.unsubscribe = null;
};

const resetClientAuthState = (state: ClientState): void => {
  state.authenticated = false;
  state.userId = null;
  state.groups = [];
  state.afterSyncId = "0";
  state.replaying = false;
  state.bufferedActions = [];
};

const setSubscribedState = (
  state: ClientState,
  userId: string,
  groups: string[],
  afterSyncId: string
): void => {
  state.userId = userId;
  state.groups = groups;
  state.authenticated = true;
  state.afterSyncId = afterSyncId;
  state.replaying = true;
  state.bufferedActions = [];
};

const resolveSubscribeGroups = (
  authorizedGroups: string[],
  requestedGroups?: string[]
): {
  groups: string[];
  rejectedGroups: string[];
} => {
  const dedupedAuthorizedGroups = dedupeSyncGroups(authorizedGroups);
  const dedupedRequestedGroups = requestedGroups
    ? dedupeSyncGroups(requestedGroups)
    : undefined;
  const allowedGroups = new Set(dedupedAuthorizedGroups);
  const groups = resolveRequestedSyncGroups(
    dedupedAuthorizedGroups,
    dedupedRequestedGroups
  );
  const rejectedGroups = dedupedRequestedGroups
    ? dedupedRequestedGroups.filter((group) => !allowedGroups.has(group))
    : [];

  return { groups, rejectedGroups };
};

const sendSubscribedMessage = (ws: WebSocket, state: ClientState): void => {
  ws.send(
    JSON.stringify({
      afterSyncId: state.afterSyncId,
      groups: state.groups,
      type: "subscribed",
    })
  );
};

const bufferOrSendLiveDelta = (
  ws: WebSocket,
  state: ClientState,
  action: SyncActionOutput,
  groups: string[],
  sendDeltaAction: (
    ws: WebSocket,
    state: ClientState,
    action: SyncActionOutput
  ) => void
): void => {
  if (state.closed) {
    return;
  }

  if (!hasGroupOverlap(state.groups, groups)) {
    return;
  }

  const { syncId } = action;
  if (parseSyncIdString(syncId) <= parseSyncIdString(state.afterSyncId)) {
    return;
  }

  if (state.replaying) {
    if (state.bufferedActions.length >= MAX_BUFFERED_ACTIONS) {
      state.closed = true;
      unsubscribeClient(state);
      resetClientAuthState(state);
      if (ws.readyState === ws.OPEN) {
        ws.send(
          JSON.stringify({
            code: "BUFFER_OVERFLOW",
            message: "Replay buffer limit exceeded",
            type: "error",
          })
        );
        ws.close(4008, "Replay buffer limit exceeded");
      }
      return;
    }

    state.bufferedActions.push({ action, groups });
    return;
  }

  sendDeltaAction(ws, state, action);
};

const installDeltaSubscription = (
  ws: WebSocket,
  state: ClientState,
  deltaSubscriber: DeltaSubscriberLike | undefined,
  sendDeltaAction: (
    ws: WebSocket,
    state: ClientState,
    action: SyncActionOutput
  ) => void
): void => {
  if (!deltaSubscriber) {
    return;
  }

  state.unsubscribe = deltaSubscriber.onDelta(
    (action: SyncActionOutput, groups: string[]) => {
      bufferOrSendLiveDelta(ws, state, action, groups, sendDeltaAction);
    }
  );
};

const replaySyncActions = async (
  syncDao: SyncDao,
  ws: WebSocket,
  state: ClientState,
  sendDeltaAction: (
    ws: WebSocket,
    state: ClientState,
    action: SyncActionOutput
  ) => void
): Promise<void> => {
  let replayCursor = state.afterSyncId;

  while (true) {
    if (state.closed || ws.readyState !== ws.OPEN) {
      return;
    }

    const actions = await syncDao.getSyncActions(
      parseSyncIdString(replayCursor),
      state.groups,
      1000
    );
    if (actions.length === 0) {
      break;
    }

    for (const action of actions) {
      sendDeltaAction(
        ws,
        state,
        toSyncActionOutput(
          action as {
            id: bigint;
            model: string;
            modelId: string;
            action: string;
            data: unknown;
            groupId: string | null;
            clientTxId: string | null;
            clientId: string | null;
            createdAt: Date;
          }
        )
      );
    }

    const lastAction = actions.at(-1);
    if (!lastAction || actions.length < 1000) {
      break;
    }

    replayCursor = serializeSyncId((lastAction as { id: bigint }).id);
  }
};

const flushBufferedActions = (
  ws: WebSocket,
  state: ClientState,
  sendDeltaAction: (
    ws: WebSocket,
    state: ClientState,
    action: SyncActionOutput
  ) => void
): void => {
  state.replaying = false;
  state.bufferedActions.sort((left, right) =>
    compareSyncActionOutput(left.action, right.action)
  );

  const seenSyncIds = new Set<string>();
  for (const entry of state.bufferedActions) {
    if (seenSyncIds.has(entry.action.syncId)) {
      continue;
    }
    seenSyncIds.add(entry.action.syncId);

    if (!hasGroupOverlap(state.groups, entry.groups)) {
      continue;
    }

    sendDeltaAction(ws, state, entry.action);
  }

  state.bufferedActions = [];
};

interface RegisterWebSocketOptions {
  auth: SyncAuthConfig;
  syncDao: SyncDao;
  deltaSubscriber?: DeltaSubscriberLike;
  hooks?: WebSocketHooks;
  logger?: SyncLogger;
}

export const registerSyncWebsocket = (
  server: FastifyInstance,
  options: RegisterWebSocketOptions
): void => {
  const {
    auth,
    deltaSubscriber,
    hooks,
    logger = noopLogger,
    syncDao,
  } = options;

  // Use route registration that is compatible with @fastify/websocket
  // The `websocket: true` option and handler signature come from the plugin
  (
    server as unknown as {
      get(
        path: string,
        opts: Record<string, unknown>,
        handler: (socket: WebSocket) => void
      ): void;
    }
  ).get(
    "/sync/ws",
    {
      preValidation: async (
        request: { query: Record<string, string> },
        reply: { code(n: number): { send(body: unknown): void } }
      ) => {
        const token = request.query?.token;
        if (!token) {
          reply.code(401).send({ error: "Token required" });
          return;
        }
        try {
          const payload = await auth.verifyToken(token);
          if (!payload) {
            reply.code(401).send({ error: "Invalid token" });
          }
        } catch {
          reply.code(401).send({ error: "Invalid token" });
        }
      },
      websocket: true,
    },
    (socket: WebSocket) => {
      const connectionId = randomUUID();
      const clientState: ClientState = {
        afterSyncId: "0",
        authenticated: false,
        bufferedActions: [],
        closed: false,
        groups: [],
        replaying: false,
        unsubscribe: null,
        userId: null,
      };
      const messageMutex = new AsyncMutex();
      let cleanupPerformed = false;
      let awaitingPong = false;

      const heartbeatInterval = setInterval(() => {
        if (clientState.closed) {
          return;
        }

        if (socket.readyState !== socket.OPEN) {
          return;
        }

        if (awaitingPong) {
          logger.warn(
            { connId: connectionId },
            "WebSocket heartbeat timed out"
          );
          socket.close(1011, "Heartbeat timeout");
          return;
        }

        awaitingPong = true;

        if (socket.readyState === socket.OPEN) {
          socket.ping();
        }
      }, HEARTBEAT_INTERVAL_MS);

      const getConnectionContext = () => ({
        connId: connectionId,
        groups: clientState.groups,
        userId: clientState.userId ?? `anonymous-${connectionId}`,
      });

      const sendDeltaAction = (
        ws: WebSocket,
        state: ClientState,
        action: SyncActionOutput
      ): void => {
        if (state.closed) {
          return;
        }

        const { syncId } = action;
        if (parseSyncIdString(syncId) <= parseSyncIdString(state.afterSyncId)) {
          return;
        }

        state.afterSyncId = syncId;

        const deltaMessage: DeltaMessage = {
          packet: {
            actions: [
              {
                action: action.action,
                clientId: action.clientId,
                clientTxId: action.clientTxId,
                createdAt: action.createdAt.toISOString(),
                data: action.data,
                groupId: action.groupId,
                modelId: action.modelId,
                modelName: action.modelName,
                syncId,
              },
            ],
            lastSyncId: syncId,
          },
          type: "delta",
        };

        if (ws.readyState === ws.OPEN) {
          ws.send(safeJsonStringify(deltaMessage));
        }
      };

      const sendSocketError = (message: string, code?: string): void => {
        if (socket.readyState !== socket.OPEN) {
          return;
        }

        socket.send(
          JSON.stringify({
            ...(code ? { code } : {}),
            message,
            type: "error",
          })
        );
      };

      const getEarliestSyncId = async (): Promise<bigint | null> =>
        await syncDao.getEarliestSyncId();

      const handleSubscribe = async (
        ws: WebSocket,
        state: ClientState,
        msg: SubscribeMessage
      ): Promise<void> => {
        const previousContext = getConnectionContext();

        unsubscribeClient(state);
        resetClientAuthState(state);

        if (hooks?.onSubscribe) {
          await hooks.onSubscribe(ws, getConnectionContext(), previousContext);
        }

        let payload;
        try {
          payload = await auth.verifyToken(msg.token);
        } catch {
          sendSocketError("Invalid token");
          return;
        }
        if (!payload) {
          sendSocketError("Invalid token");
          return;
        }

        let resolvedGroups: string[];
        let dbGroups: string[];
        try {
          [resolvedGroups, dbGroups] = await Promise.all([
            auth.resolveGroups(payload.userId),
            syncDao.getUserGroups(payload.userId),
          ]);
        } catch (error) {
          logger.error({ error }, "WebSocket group resolution failed");
          sendSocketError("Failed to resolve sync groups");
          if (socket.readyState === socket.OPEN) {
            socket.close(1011, "Failed to resolve sync groups");
          }
          return;
        }
        const authorizedGroups = dedupeSyncGroups([
          ...resolvedGroups,
          ...dbGroups,
          payload.userId,
        ]);
        const { groups, rejectedGroups } = resolveSubscribeGroups(
          authorizedGroups,
          msg.groups
        );

        if (rejectedGroups.length > 0) {
          logger.warn(
            {
              authorizedGroups,
              requestedGroups: rejectedGroups,
              userId: payload.userId,
            },
            "Rejected unauthorized WebSocket sync groups"
          );
        }

        setSubscribedState(
          state,
          payload.userId,
          groups,
          msg.afterSyncId ?? "0"
        );

        const earliestSyncId = await getEarliestSyncId();
        if (
          earliestSyncId !== null &&
          parseSyncIdString(state.afterSyncId) > 0n &&
          earliestSyncId > 0n &&
          parseSyncIdString(state.afterSyncId) < earliestSyncId
        ) {
          unsubscribeClient(state);
          resetClientAuthState(state);
          sendSocketError(
            "A fresh bootstrap is required before subscribing to deltas",
            "BOOTSTRAP_REQUIRED"
          );
          return;
        }

        installDeltaSubscription(ws, state, deltaSubscriber, sendDeltaAction);
        try {
          await replaySyncActions(syncDao, ws, state, sendDeltaAction);
          if (state.closed) {
            return;
          }
          flushBufferedActions(ws, state, sendDeltaAction);
          if (state.closed) {
            return;
          }
          sendSubscribedMessage(ws, state);
        } catch (replayError) {
          unsubscribeClient(state);
          resetClientAuthState(state);
          sendSocketError("Replay failed");
          if (socket.readyState === socket.OPEN) {
            socket.close(1011, "Replay failed");
          }
          logger.warn({ error: replayError }, "WebSocket replay failed");
        }
      };

      const maybeHandleSubscribeFrame = async (
        message: Record<string, unknown>
      ): Promise<boolean> => {
        if (isSubscribeMessage(message)) {
          await handleSubscribe(socket, clientState, message);
          return true;
        }

        if (message.type === "subscribe") {
          socket.send(
            JSON.stringify({
              message: "Authentication required",
              type: "error",
            })
          );
          return true;
        }

        return false;
      };

      const maybeHandleHookMessage = async (
        message: Record<string, unknown>
      ): Promise<boolean> => {
        if (!hooks?.onMessage) {
          return false;
        }

        if (!clientState.authenticated) {
          return false;
        }

        return await hooks.onMessage(socket, message, getConnectionContext());
      };

      socket.on("message", async (data: Buffer | ArrayBuffer | Buffer[]) => {
        await messageMutex.runExclusive(async () => {
          try {
            const message: unknown = JSON.parse(data.toString());
            if (!isRecord(message)) {
              return;
            }

            if (await maybeHandleSubscribeFrame(message)) {
              return;
            }

            await maybeHandleHookMessage(message);
          } catch (error) {
            logger.warn({ error }, "WebSocket message handling error");
          }
        });
      });

      const safeRunOnClose = async (): Promise<void> => {
        if (!hooks?.onClose) {
          return;
        }
        try {
          await hooks.onClose(socket, getConnectionContext());
        } catch {
          // Silently ignore cleanup errors during disconnect
        }
      };

      const cleanupWebSocket = (): void => {
        if (cleanupPerformed) {
          return;
        }
        cleanupPerformed = true;
        clientState.closed = true;
        awaitingPong = false;
        clearInterval(heartbeatInterval);
        if (clientState.unsubscribe) {
          clientState.unsubscribe();
          clientState.unsubscribe = null;
        }
        safeRunOnClose();
      };

      socket.on("pong", () => {
        awaitingPong = false;
      });
      socket.on("close", cleanupWebSocket);

      socket.on("error", (error) => {
        logger.warn({ error }, "WebSocket error");
        cleanupWebSocket();
      });
    }
  );
};
