import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";

import { authorizeToken } from "../auth/authorize.js";
import type { AuthResult } from "../auth/authorize.js";
import type { SyncAuthConfig, SyncLogger, WebSocketHooks } from "../config.js";
import { noopLogger } from "../config.js";
import {
  BOOTSTRAP_REQUIRED,
  BOOTSTRAP_REQUIRED_WS_MESSAGE,
} from "../core/errors.js";
import { isRecord } from "../core/guards.js";
import { SyncId } from "../core/sync-id.js";
import type { SyncDao } from "../dao/sync-dao.js";
import type { DeltaSubscriberLike } from "../delta/delta-publisher.js";
import { extractBearerToken } from "../fastify/middleware.js";
import type { SyncUserContext } from "../types.js";
import { AsyncMutex } from "../utils/async-mutex.js";
import {
  dedupeSyncGroups,
  resolveRequestedSyncGroups,
} from "../utils/sync-scope.js";
import { ClientSession } from "./client-session.js";
import { startHeartbeat } from "./heartbeat.js";
import type { SubscribeMessage } from "./messages.js";
import {
  buildErrorFrame,
  buildSubscribedFrame,
  isSubscribeMessage,
} from "./messages.js";
import { replaySyncActions } from "./replay.js";

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

interface RegisterWebSocketOptions {
  auth: SyncAuthConfig;
  syncDao: SyncDao;
  deltaSubscriber?: DeltaSubscriberLike;
  hooks?: WebSocketHooks;
  logger?: SyncLogger;
}

interface SyncWebSocketRequest {
  headers?: { authorization?: string };
  query?: Record<string, unknown>;
  syncToken?: string;
  syncUser?: SyncUserContext;
}

interface WebSocketUpgradeReply {
  code(statusCode: number): { send(body: unknown): void };
}

const rejectWebSocketUpgradeAuth = (
  result: AuthResult,
  reply: WebSocketUpgradeReply
): boolean => {
  switch (result.status) {
    case "authorized": {
      return false;
    }
    case "invalid_token": {
      reply.code(401).send({ error: "Invalid token" });
      return true;
    }
    case "access_denied": {
      reply.code(403).send({ error: "Access denied" });
      return true;
    }
    case "group_failure": {
      reply.code(500).send({ error: "Failed to resolve sync groups" });
      return true;
    }
    case "policy_failure": {
      reply.code(500).send({ error: "Failed to authorize sync access" });
      return true;
    }
    default: {
      return true;
    }
  }
};

const rejectWebSocketAuth = (
  result: AuthResult,
  socket: WebSocket,
  sendError: (message: string, code?: string) => void
): boolean => {
  switch (result.status) {
    case "authorized": {
      return false;
    }
    case "invalid_token": {
      sendError("Invalid token");
      return true;
    }
    case "access_denied": {
      sendError("Access denied");
      return true;
    }
    case "group_failure": {
      sendError("Failed to resolve sync groups");
      if (socket.readyState === socket.OPEN) {
        socket.close(1011, "Failed to resolve sync groups");
      }
      return true;
    }
    case "policy_failure": {
      sendError("Failed to authorize sync access");
      if (socket.readyState === socket.OPEN) {
        socket.close(1011, "Failed to authorize sync access");
      }
      return true;
    }
    default: {
      return true;
    }
  }
};

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
  const groupRefreshCatchUpIntervalMs =
    auth.webSocketGroupRefreshCatchUpIntervalMs;
  if (
    groupRefreshCatchUpIntervalMs !== undefined &&
    (!Number.isFinite(groupRefreshCatchUpIntervalMs) ||
      groupRefreshCatchUpIntervalMs <= 0)
  ) {
    throw new TypeError(
      "webSocketGroupRefreshCatchUpIntervalMs must be a positive finite number"
    );
  }

  // Use route registration that is compatible with @fastify/websocket.
  // The `websocket: true` option and single-arg handler signature come from the
  // plugin, so the registration cast must stay.
  (
    server as unknown as {
      get(
        path: string,
        opts: Record<string, unknown>,
        handler: (socket: WebSocket, request?: SyncWebSocketRequest) => void
      ): void;
    }
  ).get(
    "/sync/ws",
    {
      preValidation: async (
        request: SyncWebSocketRequest,
        reply: WebSocketUpgradeReply
      ) => {
        const queryToken = request.query?.token;
        const header = request.headers?.authorization;
        const headerToken = extractBearerToken(header);

        if (header !== undefined && !headerToken) {
          reply.code(401).send({ error: "Invalid authorization format" });
          return;
        }
        if (
          headerToken &&
          queryToken !== undefined &&
          queryToken !== headerToken
        ) {
          reply.code(400).send({ error: "Conflicting WebSocket credentials" });
          return;
        }

        const token =
          headerToken ?? (typeof queryToken === "string" ? queryToken : null);
        if (!token) {
          reply.code(401).send({ error: "Token required" });
          return;
        }

        const result = await authorizeToken(
          auth,
          syncDao,
          token,
          logger,
          "read"
        );
        if (rejectWebSocketUpgradeAuth(result, reply)) {
          return;
        }
        if (result.status !== "authorized") {
          return;
        }
        request.syncToken = token;
        request.syncUser = result.user;
      },
      websocket: true,
    },
    (socket: WebSocket, request?: SyncWebSocketRequest) => {
      const connectionId = randomUUID();
      const messageMutex = new AsyncMutex();
      const session = new ClientSession(socket, deltaSubscriber, {
        deliveryMutex: messageMutex,
        ...(groupRefreshCatchUpIntervalMs
          ? { groupRefreshGuardDao: syncDao }
          : {}),
        ...(auth.reauthorizeBeforeWebSocketDelivery
          ? {
              reauthorizeDelivery: async (token: string) => {
                const result = await authorizeToken(
                  auth,
                  syncDao,
                  token,
                  logger,
                  "read"
                );
                return result.status === "authorized" ? result.user : null;
              },
            }
          : {}),
      });
      let cleanupPerformed = false;
      let initialUser = request?.syncUser;

      const heartbeat = startHeartbeat(
        socket,
        connectionId,
        logger,
        () => session.isClosed
      );
      let groupRefreshCatchUpRunning = false;
      const groupRefreshCatchUpTimer = groupRefreshCatchUpIntervalMs
        ? setInterval(async () => {
            if (groupRefreshCatchUpRunning) {
              return;
            }
            groupRefreshCatchUpRunning = true;
            try {
              await messageMutex.runExclusive(async () => {
                await session.catchUpGroupRefreshActions(syncDao);
              });
            } catch (error) {
              logger.warn(
                { connId: connectionId, error },
                "WebSocket group refresh catch-up failed"
              );
            } finally {
              groupRefreshCatchUpRunning = false;
            }
          }, groupRefreshCatchUpIntervalMs)
        : undefined;
      groupRefreshCatchUpTimer?.unref();

      const getConnectionContext = () => ({
        connId: connectionId,
        groups: session.groups,
        ...(session.principal === undefined
          ? {}
          : { principal: session.principal }),
        userId: session.userId ?? `anonymous-${connectionId}`,
      });

      const sendSocketError = (message: string, code?: string): void => {
        if (socket.readyState !== socket.OPEN) {
          return;
        }
        socket.send(buildErrorFrame(message, code));
      };

      // oxlint-disable-next-line eslint/complexity -- auth, replay, and retention failures deliberately share one serialized lifecycle
      const handleSubscribe = async (msg: SubscribeMessage): Promise<void> => {
        const previousContext = getConnectionContext();

        session.reset();

        let user = initialUser;
        initialUser = undefined;
        if (!user) {
          const authResult = await authorizeToken(
            auth,
            syncDao,
            request?.syncToken ?? msg.token,
            logger,
            "read"
          );
          if (session.isClosed) {
            return;
          }

          // WS does not distinguish expired tokens from invalid ones.
          if (rejectWebSocketAuth(authResult, socket, sendSocketError)) {
            return;
          }

          if (authResult.status !== "authorized") {
            return;
          }
          const { user: authorizedUser } = authResult;
          user = authorizedUser;
        }
        const authorizedGroups = user.groups;
        const { groups, rejectedGroups } = resolveSubscribeGroups(
          authorizedGroups,
          msg.groups
        );

        if (rejectedGroups.length > 0) {
          logger.warn(
            {
              authorizedGroups,
              requestedGroups: rejectedGroups,
              userId: user.userId,
            },
            "Rejected unauthorized WebSocket sync groups"
          );
          if (groupRefreshCatchUpIntervalMs) {
            sendSocketError(BOOTSTRAP_REQUIRED_WS_MESSAGE, BOOTSTRAP_REQUIRED);
            return;
          }
        }

        const requestedAfterSyncId = SyncId.parse(msg.afterSyncId ?? "0");
        const token = request?.syncToken ?? msg.token;
        session.beginReplay(
          user.userId,
          groups,
          requestedAfterSyncId,
          token,
          user.principal
        );

        if (hooks?.onSubscribe) {
          await hooks.onSubscribe(
            socket,
            getConnectionContext(),
            previousContext
          );
          if (session.isClosed) {
            return;
          }
        }

        const earliestSyncId = await syncDao.getEarliestSyncId();
        if (session.isClosed) {
          return;
        }
        if (
          requestedAfterSyncId > 0n &&
          earliestSyncId > 0n &&
          requestedAfterSyncId < earliestSyncId
        ) {
          session.reset();
          sendSocketError(BOOTSTRAP_REQUIRED_WS_MESSAGE, BOOTSTRAP_REQUIRED);
          return;
        }

        session.installDeltaSubscription();

        try {
          await replaySyncActions(syncDao, socket, session);
          if (session.isClosed) {
            return;
          }
          await session.flushBufferedActions();
          if (session.isClosed) {
            return;
          }
          if (!(await session.authorizeSubscribedFrame())) {
            return;
          }
          socket.send(
            buildSubscribedFrame(
              SyncId.serialize(session.afterSyncId),
              session.groups
            )
          );
        } catch (replayError) {
          session.reset();
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
          await handleSubscribe(message);
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
        if (session.phase !== "live" && session.phase !== "replaying") {
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
        session.close();
        heartbeat.stop();
        if (groupRefreshCatchUpTimer) {
          clearInterval(groupRefreshCatchUpTimer);
        }
        safeRunOnClose();
      };

      socket.on("pong", () => {
        heartbeat.onPong();
      });
      socket.on("close", cleanupWebSocket);

      socket.on("error", (error) => {
        logger.warn({ error }, "WebSocket error");
        cleanupWebSocket();
      });
    }
  );
};
