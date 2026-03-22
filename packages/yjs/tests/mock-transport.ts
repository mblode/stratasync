import { vi } from "vitest";

import type {
  ClientMessage,
  ServerMessage,
  YjsTransport,
  YjsTransportConnectionState,
} from "../src/types";

export const createMockTransport = (): YjsTransport & {
  sentMessages: ClientMessage[];
  triggerMessage: (message: ServerMessage) => void;
  triggerConnectionState: (state: YjsTransportConnectionState) => void;
} => {
  const messageCallbacks: ((message: ServerMessage) => void)[] = [];
  const connectionStateCallbacks: ((
    state: YjsTransportConnectionState
  ) => void)[] = [];
  const sentMessages: ClientMessage[] = [];
  let connectionState: YjsTransportConnectionState = "connected";

  return {
    isConnected: vi.fn(() => connectionState === "connected"),
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    onConnectionStateChange: (callback) => {
      connectionStateCallbacks.push(callback);
      // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
      callback(connectionState);
      return () => {
        const index = connectionStateCallbacks.indexOf(callback);
        if (index !== -1) {
          connectionStateCallbacks.splice(index, 1);
        }
      };
    },
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    onMessage: (callback) => {
      messageCallbacks.push(callback);
      return () => {
        const index = messageCallbacks.indexOf(callback);
        if (index !== -1) {
          messageCallbacks.splice(index, 1);
        }
      };
    },
    send: vi.fn((message: ClientMessage) => {
      sentMessages.push(message);
    }),
    sentMessages,
    triggerConnectionState: (state: YjsTransportConnectionState) => {
      connectionState = state;
      for (const callback of connectionStateCallbacks) {
        // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
        callback(state);
      }
    },
    triggerMessage: (message: ServerMessage) => {
      for (const callback of messageCallbacks) {
        // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
        callback(message);
      }
    },
  };
};
