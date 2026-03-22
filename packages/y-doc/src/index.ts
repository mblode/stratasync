/* oxlint-disable check-tag-names */
/**
 * @stratasync/y-doc - Yjs collaborative editing integration.
 */

// biome-ignore-all lint/performance/noBarrelFile: This is the package's main entry point

export { YjsDocumentManager } from "./document-manager.js";
export {
  clearPersistedYjsDocuments,
  createPersistedYjsPrefix,
  DEFAULT_PERSISTED_YJS_PREFIX,
} from "./persistence.js";
export { YjsPresenceManager } from "./presence-manager.js";
export type {
  ClientMessage,
  ServerMessage,
  YjsTransport,
  YjsTransportConnectionState,
} from "./types.js";
export {
  isLiveEditingErrorMessage,
  isSessionStateMessage,
  isYjsSyncStep2Message,
  isYjsUpdateMessage,
} from "./types.js";
