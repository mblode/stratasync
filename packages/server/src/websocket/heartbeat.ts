import type { WebSocket } from "ws";

import type { SyncLogger } from "../config.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

export interface Heartbeat {
  /** Call when a pong is received to clear the outstanding ping. */
  onPong(): void;
  /** Stops the heartbeat timer. */
  stop(): void;
}

/**
 * Starts a 30s heartbeat. Each tick pings the socket; if the previous ping went
 * unanswered, the socket is closed with 1011 "Heartbeat timeout".
 */
export const startHeartbeat = (
  socket: WebSocket,
  connectionId: string,
  logger: SyncLogger,
  isClosed: () => boolean
): Heartbeat => {
  let awaitingPong = false;

  const interval = setInterval(() => {
    if (isClosed() || socket.readyState !== socket.OPEN) {
      return;
    }

    if (awaitingPong) {
      logger.warn({ connId: connectionId }, "WebSocket heartbeat timed out");
      socket.close(1011, "Heartbeat timeout");
      return;
    }

    awaitingPong = true;
    if (socket.readyState === socket.OPEN) {
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  return {
    onPong(): void {
      awaitingPong = false;
    },
    stop(): void {
      awaitingPong = false;
      clearInterval(interval);
    },
  };
};
