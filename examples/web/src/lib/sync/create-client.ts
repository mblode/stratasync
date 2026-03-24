import type { SyncClient } from "@stratasync/client";
import { createSyncClient } from "@stratasync/client";
import { ModelRegistry } from "@stratasync/core";
import { createMobXReactivity } from "@stratasync/mobx";
import { createIndexedDbStorage } from "@stratasync/storage-idb";
import { GraphQLTransportAdapter } from "@stratasync/transport-graphql";

import { API_BASE_URL, DEV_GROUP_ID, DEV_TOKEN, DEV_USER_ID } from "./config";
import "./models";

const HTTP_PROTOCOL_RE = /^http/;
const SYNC_DB_PREFIX = "stratasync-example";
const SYNC_REQUEST_TIMEOUT_MS = 30_000;
const SYNC_USER_VERSION = 1;

let clientInstance: SyncClient | null = null;

const getDbName = (userId: string): string =>
  `${SYNC_DB_PREFIX}-v${SYNC_USER_VERSION}-${userId}`;

export const getSyncClient = (): SyncClient => {
  if (clientInstance) {
    return clientInstance;
  }

  const schema = ModelRegistry.snapshot();
  const wsUrl = API_BASE_URL.replace(HTTP_PROTOCOL_RE, "ws");
  const storage = createIndexedDbStorage();

  const transport = new GraphQLTransportAdapter({
    auth: {
      getAccessToken: () => Promise.resolve(DEV_TOKEN),
    },
    endpoint: `${API_BASE_URL}/sync`,
    syncEndpoint: `${API_BASE_URL}/sync`,
    timeout: SYNC_REQUEST_TIMEOUT_MS,
    wsEndpoint: `${wsUrl}/sync/ws`,
  });

  const rawClient = createSyncClient({
    batchDelay: 100,
    batchMutations: true,
    dbName: getDbName(DEV_USER_ID),
    groups: [DEV_GROUP_ID],
    optimistic: true,
    reactivity: createMobXReactivity(),
    schema,
    storage,
    transport,
    userId: DEV_USER_ID,
    userVersion: SYNC_USER_VERSION,
  });

  clientInstance = rawClient;
  return rawClient;
};
