import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";

import { authorizeToken } from "../auth/authorize.js";
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

  // Use route registration that is compatible with @fastify/websocket.
  // The `websocket: true` option and single-arg handler signature come from the
  // plugin, so the registration cast must stay.
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
      const session = new ClientSession(socket, deltaSubscriber);
      const messageMutex = new AsyncMutex();
      let cleanupPerformed = false;

      const heartbeat = startHeartbeat(
        socket,
        connectionId,
        logger,
        () => session.isClosed
      );

      const getConnectionContext = () => ({
        connId: connectionId,
        groups: session.groups,
        userId: session.userId ?? `anonymous-${connectionId}`,
      });

      const sendSocketError = (message: string, code?: string): void => {
        if (socket.readyState !== socket.OPEN) {
          return;
        }
        socket.send(buildErrorFrame(message, code));
      };

      const handleSubscribe = async (msg: SubscribeMessage): Promise<void> => {
        const previousContext = getConnectionContext();

        session.reset();

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

        const authResult = await authorizeToken(
          auth,
          syncDao,
          msg.token,
          logger
        );
        if (session.isClosed) {
          return;
        }

        // WS does not distinguish expired tokens from invalid ones.
        if (authResult.status === "invalid_token") {
          sendSocketError("Invalid token");
          return;
        }

        if (authResult.status === "group_failure") {
          sendSocketError("Failed to resolve sync groups");
          if (socket.readyState === socket.OPEN) {
            socket.close(1011, "Failed to resolve sync groups");
          }
          return;
        }

        const { user } = authResult;
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
        }

        const requestedAfterSyncId = SyncId.parse(msg.afterSyncId ?? "0");
        session.beginReplay(user.userId, groups, requestedAfterSyncId);

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
          session.flushBufferedActions();
          if (session.isClosed) {
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
