// oxlint-disable no-use-before-define -- helper functions and class methods reference later-defined utilities
/**
 * YjsDocumentManager - Manages local Y.Doc instances for collaborative editing.
 *
 * Responsibilities:
 * - Create and manage Y.Doc instances per document field
 * - Handle Yjs sync protocol (state vector exchange)
 * - Apply local and remote updates
 * - Track connection state per document
 * - Generate derived content from Y.Doc
 */

// biome-ignore lint/performance/noNamespaceImport: yjs conventionally uses namespace access (Y.Doc, Y.Text, etc.)
import * as Y from "yjs";

import {
  clearPersistedYjsDocuments,
  DEFAULT_PERSISTED_YJS_PREFIX,
} from "./persistence.js";
import type {
  ClientMessage,
  ConnectOptions,
  DocumentConnectionState,
  DocumentKey,
  LiveEditingErrorMessage,
  LiveEditingRetryConfig,
  ServerMessage,
  YjsDocumentManagerConfig,
  YjsSyncStep2Message,
  YjsTransport,
  YjsTransportConnectionState,
  YjsUpdateMessage,
} from "./types.js";
import {
  DEFAULT_LIVE_EDITING_RETRY_CONFIG,
  fromDocumentKeyString,
  isLiveEditingErrorMessage,
  isRetryableLiveEditingErrorCode,
  isYjsSyncStep2Message,
  isYjsUpdateMessage,
  toDocumentKeyString,
} from "./types.js";

const PROSEMIRROR_FIELD = "prosemirror";
const IMAGE_NODE_NAMES = new Set(["image", "imageblock", "taskimage"]);
const BLOCK_IMAGE_NODE_NAMES = new Set(["imageblock"]);
const EMBED_NODE_NAMES = new Set([
  "embed",
  "embedblock",
  "iframelyembed",
  "iframelyembedblock",
  "iframe",
  "iframeblock",
  "taskembed",
]);

const normalizeDerivedPart = (value: string, maxLength = 160): string => {
  const normalized = normalizeDerivedContent(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
};

const normalizeDerivedContent = (content: string): string =>
  content
    .replaceAll("\u00A0", " ")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();

const getStringAttribute = (
  node: Y.XmlElement,
  attributeNames: readonly string[]
): string | null => {
  for (const attributeName of attributeNames) {
    const value = node.getAttribute(attributeName);
    if (typeof value !== "string") {
      continue;
    }

    const normalized = normalizeDerivedPart(value);
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return null;
};

const uniqueDerivedParts = (parts: readonly (string | null)[]): string[] => {
  const uniqueParts: string[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    if (!part) {
      continue;
    }

    const key = part.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueParts.push(part);
  }

  return uniqueParts;
};

const formatPlaceholder = (label: string, parts: readonly string[]): string => {
  if (parts.length === 0) {
    return `[${label}]`;
  }

  return `[${label}: ${parts.join(" - ")}]`;
};

const renderBlockPlaceholder = (
  placeholder: string,
  children: string
): string => {
  const content = normalizeDerivedContent(
    [placeholder, children].filter(Boolean).join("\n")
  );

  return content.length > 0 ? `${content}\n\n` : "";
};

const renderImagePlaceholder = (
  node: Y.XmlElement,
  children: string
): string => {
  const alt = getStringAttribute(node, ["alt", "title"]) ?? "Image";
  const src = getStringAttribute(node, ["src"]);

  if (src) {
    const nodeType = node.nodeName.toLowerCase();
    const markdown = `![${alt}](${src})`;
    if (BLOCK_IMAGE_NODE_NAMES.has(nodeType)) {
      const content = normalizeDerivedContent(
        [markdown, children].filter(Boolean).join("\n")
      );
      return content.length > 0 ? `${content}\n\n` : "";
    }
    return markdown;
  }

  const placeholder = formatPlaceholder(
    "Image",
    [alt === "Image" ? null : alt].filter(
      (part): part is string => part !== null
    )
  );

  const nodeType = node.nodeName.toLowerCase();
  if (BLOCK_IMAGE_NODE_NAMES.has(nodeType)) {
    return renderBlockPlaceholder(placeholder, children);
  }

  return placeholder;
};

const renderEmbedPlaceholder = (
  node: Y.XmlElement,
  children: string
): string => {
  const title = getStringAttribute(node, ["title", "label"]);
  const description = getStringAttribute(node, ["description", "caption"]);
  const provider = getStringAttribute(node, ["provider", "providerName"]);
  const url = getStringAttribute(node, [
    "url",
    "href",
    "src",
    "iframeSrc",
    "iframeUrl",
  ]);
  const placeholder = formatPlaceholder(
    "Embed",
    uniqueDerivedParts([title, title ? null : description, provider, url])
  );

  return renderBlockPlaceholder(placeholder, children);
};

const renderProsemirrorNodes = (nodes: readonly unknown[]): string => {
  let rendered = "";
  for (const node of nodes) {
    rendered += renderProsemirrorNode(node);
  }
  return rendered;
};

const getXmlTextContent = (node: Y.XmlText): string =>
  (node.toDelta() as { insert?: string | object }[])
    .map((op) => (typeof op.insert === "string" ? op.insert : ""))
    .join("");

// oxlint-ignore-next-line complexity -- recursive ProseMirror renderer handling many node types
// oxlint-disable-next-line complexity -- complex but clear
const renderProsemirrorNode = (node: unknown): string => {
  if (node instanceof Y.XmlText) {
    return getXmlTextContent(node);
  }

  if (!(node instanceof Y.XmlElement)) {
    return "";
  }

  const children = normalizeDerivedContent(
    renderProsemirrorNodes(node.toArray())
  );
  const nodeType = node.nodeName.toLowerCase();

  if (IMAGE_NODE_NAMES.has(nodeType)) {
    return renderImagePlaceholder(node, children);
  }

  if (EMBED_NODE_NAMES.has(nodeType)) {
    return renderEmbedPlaceholder(node, children);
  }

  switch (node.nodeName) {
    case "hardBreak": {
      return "\n";
    }
    case "heading":
    case "paragraph":
    case "blockquote":
    case "codeBlock": {
      return children.length > 0 ? `${children}\n\n` : "";
    }
    case "listItem": {
      return children.length > 0 ? `- ${children}\n` : "";
    }
    case "taskItem": {
      const checkedAttribute = node.getAttribute("checked");
      const isChecked =
        checkedAttribute === true ||
        checkedAttribute === "true" ||
        checkedAttribute === 1 ||
        checkedAttribute === "1";
      return children.length > 0
        ? `- [${isChecked ? "x" : " "}] ${children}\n`
        : "";
    }
    case "bulletList":
    case "orderedList":
    case "taskList": {
      return children.length > 0 ? `${children}\n` : "";
    }
    default: {
      return children;
    }
  }
};

const deriveProsemirrorContent = (doc: Y.Doc): string => {
  const fragment = doc.getXmlFragment(PROSEMIRROR_FIELD);
  return normalizeDerivedContent(renderProsemirrorNodes(fragment.toArray()));
};

const seedProsemirrorFragment = (doc: Y.Doc, content: string): void => {
  const normalized = normalizeDerivedContent(content);
  if (normalized.length === 0) {
    return;
  }

  const fragment = doc.getXmlFragment(PROSEMIRROR_FIELD);
  if (fragment.length > 0) {
    return;
  }

  const paragraph = new Y.XmlElement("paragraph");
  const textNode = new Y.XmlText();
  textNode.insert(0, normalized);
  paragraph.insert(0, [textNode]);
  fragment.insert(fragment.length, [paragraph]);
};

interface DocumentState {
  doc: Y.Doc;
  connectionState: DocumentConnectionState;
  lastSeq: number;
  refCount: number;
  pendingLocalUpdates: Uint8Array[];
  unsubscribe?: () => void;
  pendingInitialContent?: string;
  retryAttempts: number;
  retryTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Manages Y.Doc instances for collaborative editing.
 */
export class YjsDocumentManager {
  private readonly docs = new Map<string, DocumentState>();
  private readonly remoteUpdateOrigin = { source: "remote" } as const;
  private readonly config: YjsDocumentManagerConfig;
  private readonly liveEditingRetryConfig: LiveEditingRetryConfig;
  private persistenceKeyPrefix: string;
  private transport: YjsTransport | null = null;
  private transportConnectionState: YjsTransportConnectionState =
    "disconnected";
  private unsubscribeTransportMessage: (() => void) | null = null;
  private unsubscribeTransportConnection: (() => void) | null = null;
  private readonly connectionStateCallbacks = new Map<
    string,
    Set<(state: DocumentConnectionState) => void>
  >();
  private readonly contentCallbacks = new Map<
    string,
    Set<(content: string) => void>
  >();

  constructor(config: YjsDocumentManagerConfig) {
    this.config = config;
    this.liveEditingRetryConfig = normalizeRetryConfig(config.liveEditingRetry);
    this.persistenceKeyPrefix =
      config.persistenceKeyPrefix ?? DEFAULT_PERSISTED_YJS_PREFIX;
  }

  setPersistenceKeyPrefix(prefix: string): void {
    this.persistenceKeyPrefix = prefix || DEFAULT_PERSISTED_YJS_PREFIX;
  }

  clearPersistedDocuments(): void {
    clearPersistedYjsDocuments(this.persistenceKeyPrefix);
  }

  setTransport(transport: YjsTransport): void {
    this.unsubscribeTransportMessage?.();
    this.unsubscribeTransportConnection?.();
    this.transport = transport;
    this.transportConnectionState = "disconnected";

    this.unsubscribeTransportMessage = transport.onMessage((message) => {
      this.handleMessage(message);
    });
    this.unsubscribeTransportConnection = transport.onConnectionStateChange(
      (state) => {
        this.handleTransportConnectionStateChange(state);
      }
    );

    this.handleTransportConnectionStateChange(
      transport.isConnected() ? "connected" : "disconnected"
    );
  }

  getDocument(docKey: DocumentKey): Y.Doc {
    const keyString = toDocumentKeyString(docKey);
    return this.getOrCreateState(keyString).doc;
  }

  /**
   * Connect to a document for collaborative editing.
   */
  connect(docKey: DocumentKey, options: ConnectOptions = {}): void {
    const keyString = toDocumentKeyString(docKey);
    const state = this.getOrCreateState(keyString);
    const wasActive = YjsDocumentManager.isDocActive(state);

    state.refCount += 1;

    if (wasActive) {
      return;
    }

    // Store initial content for immediate seeding in requestSyncStep1
    // (regardless of connection state). The CRDT merge in handleSyncStep2
    // reconciles if the server has different content.
    state.pendingInitialContent = options.initialContent;
    YjsDocumentManager.resetRetryState(state);
    this.attachLocalUpdateHandler(docKey, keyString, state);
    this.requestSyncStep1(docKey, keyString, state);
  }

  disconnect(docKey: DocumentKey): void {
    const keyString = toDocumentKeyString(docKey);
    const state = this.docs.get(keyString);

    if (!(state && YjsDocumentManager.isDocActive(state))) {
      return;
    }

    state.refCount -= 1;
    if (state.refCount > 0) {
      return;
    }

    state.pendingInitialContent = undefined;
    YjsDocumentManager.resetRetryState(state);
    YjsDocumentManager.detachLocalUpdateHandler(state);
    this.setConnectionState(keyString, "disconnected");
  }

  getConnectionState(docKey: DocumentKey): DocumentConnectionState {
    const keyString = toDocumentKeyString(docKey);
    return this.docs.get(keyString)?.connectionState ?? "disconnected";
  }

  onConnectionStateChange(
    docKey: DocumentKey,
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback: (state: DocumentConnectionState) => void
  ): () => void {
    const keyString = toDocumentKeyString(docKey);
    let callbacks = this.connectionStateCallbacks.get(keyString);

    if (!callbacks) {
      callbacks = new Set();
      this.connectionStateCallbacks.set(keyString, callbacks);
    }

    callbacks.add(callback);

    const currentState = this.getConnectionState(docKey);
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback(currentState);

    return () => {
      callbacks?.delete(callback);
    };
  }

  onContentChange(
    docKey: DocumentKey,
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback: (content: string) => void
  ): () => void {
    const keyString = toDocumentKeyString(docKey);
    let callbacks = this.contentCallbacks.get(keyString);

    if (!callbacks) {
      callbacks = new Set();
      this.contentCallbacks.set(keyString, callbacks);
    }

    callbacks.add(callback);

    const currentContent = this.getDerivedContent(docKey);
    // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
    callback(currentContent);

    return () => {
      callbacks?.delete(callback);
    };
  }

  /**
   * Apply a remote update to a document.
   */
  applyRemoteUpdate(docKey: DocumentKey, update: Uint8Array): void {
    const keyString = toDocumentKeyString(docKey);
    const state = this.docs.get(keyString);

    if (!state) {
      return;
    }

    Y.applyUpdate(state.doc, update, this.remoteUpdateOrigin);
    this.persistDocument(keyString, state.doc);
    this.notifyContentChange(keyString);
  }

  /**
   * Apply a snapshot (full state) to a document.
   * Semantically identical to applyRemoteUpdate. A Yjs snapshot
   * is applied using the same Y.applyUpdate mechanism.
   */
  applySnapshot(docKey: DocumentKey, snapshot: Uint8Array): void {
    this.applyRemoteUpdate(docKey, snapshot);
  }

  getDerivedContent(docKey: DocumentKey): string {
    const state = this.docs.get(toDocumentKeyString(docKey));

    if (!state) {
      return "";
    }

    return deriveProsemirrorContent(state.doc);
  }

  getStateVector(docKey: DocumentKey): Uint8Array {
    const state = this.docs.get(toDocumentKeyString(docKey));

    if (!state) {
      return new Uint8Array();
    }

    return Y.encodeStateVector(state.doc);
  }

  getUpdatesSince(
    docKey: DocumentKey,
    stateVector: Uint8Array
  ): Uint8Array | null {
    const state = this.docs.get(toDocumentKeyString(docKey));

    if (!state) {
      return null;
    }

    const update = Y.encodeStateAsUpdate(state.doc, stateVector);

    // Check if update is empty (no changes)
    if (update.length <= 2) {
      return null;
    }

    return update;
  }

  getEncodedState(docKey: DocumentKey): Uint8Array | null {
    const state = this.docs.get(toDocumentKeyString(docKey));

    if (!state) {
      return null;
    }

    return Y.encodeStateAsUpdate(state.doc);
  }

  destroy(docKey: DocumentKey): void {
    const keyString = toDocumentKeyString(docKey);
    const state = this.docs.get(keyString);

    if (state) {
      state.refCount = 0;
      state.pendingInitialContent = undefined;
      YjsDocumentManager.resetRetryState(state);
      YjsDocumentManager.detachLocalUpdateHandler(state);
      this.setConnectionState(keyString, "disconnected");
      state.doc.destroy();
      this.docs.delete(keyString);
    }

    this.connectionStateCallbacks.delete(keyString);
    this.contentCallbacks.delete(keyString);
  }

  destroyAll(): void {
    for (const [keyString] of this.docs) {
      const docKey = fromDocumentKeyString(keyString);
      if (docKey) {
        this.destroy(docKey);
      }
    }
  }

  private getOrCreateState(keyString: string): DocumentState {
    let state = this.docs.get(keyString);
    if (!state) {
      state = YjsDocumentManager.createDocumentState();
      this.restorePersistedDocument(keyString, state.doc);
      this.docs.set(keyString, state);
    }
    return state;
  }

  private static createDocumentState(): DocumentState {
    return {
      connectionState: "disconnected",
      doc: new Y.Doc(),
      lastSeq: 0,
      pendingLocalUpdates: [],
      refCount: 0,
      retryAttempts: 0,
    };
  }

  private handleTransportConnectionStateChange(
    state: YjsTransportConnectionState
  ): void {
    const wasConnected = this.transportConnectionState === "connected";
    const isConnected = state === "connected";
    this.transportConnectionState = state;

    if (!isConnected) {
      this.markActiveDocumentsAsConnecting();
      return;
    }

    if (!wasConnected) {
      this.replaySyncStep1ForActiveDocuments();
    }
  }

  private markActiveDocumentsAsConnecting(): void {
    for (const [keyString, state] of this.docs) {
      if (!YjsDocumentManager.isDocActive(state)) {
        continue;
      }
      this.setConnectionState(keyString, "connecting");
    }
  }

  private replaySyncStep1ForActiveDocuments(): void {
    for (const [keyString, state] of this.docs) {
      if (!YjsDocumentManager.isDocActive(state)) {
        continue;
      }
      const docKey = fromDocumentKeyString(keyString);
      if (!docKey) {
        continue;
      }
      this.requestSyncStep1(docKey, keyString, state);
    }
  }

  private requestSyncStep1(
    docKey: DocumentKey,
    keyString: string,
    state: DocumentState
  ): void {
    if (!YjsDocumentManager.isDocActive(state)) {
      this.setConnectionState(keyString, "disconnected");
      return;
    }

    // Seed initial content immediately so the editor can render without
    // waiting for the sync handshake round-trip. The CRDT merge in
    // handleSyncStep2 reconciles if the server has different content.
    // Uses remoteUpdateOrigin so the local update handler does not buffer
    // seeded content as a pending local update.
    if (YjsDocumentManager.seedPendingContent(state, this.remoteUpdateOrigin)) {
      this.notifyContentChange(keyString);
    }

    if (!this.transport?.isConnected()) {
      this.setConnectionState(keyString, "connecting");
      return;
    }

    this.setConnectionState(keyString, "syncing");
    this.sendSyncStep1(docKey);
  }

  /**
   * Seed pending initial content into the Y.Doc. Returns true if content was seeded.
   *
   * Uses `origin` so the local update handler ignores the insert (prevents
   * seeded content from being buffered as a pending local update).
   */
  private static seedPendingContent(
    state: DocumentState,
    origin: object
  ): boolean {
    const { pendingInitialContent } = state;
    if (pendingInitialContent === undefined) {
      return false;
    }
    state.pendingInitialContent = undefined;
    if (state.doc.getXmlFragment(PROSEMIRROR_FIELD).length > 0) {
      return false;
    }
    state.doc.transact(() => {
      seedProsemirrorFragment(state.doc, pendingInitialContent);
    }, origin);
    return true;
  }

  private static clearRetryTimer(state: DocumentState): void {
    if (state.retryTimer !== undefined) {
      clearTimeout(state.retryTimer);
      state.retryTimer = undefined;
    }
  }

  private static resetRetryState(state: DocumentState): void {
    YjsDocumentManager.clearRetryTimer(state);
    state.retryAttempts = 0;
  }

  private scheduleRetrySyncStep1(
    docKey: DocumentKey,
    keyString: string,
    state: DocumentState
  ): void {
    if (!YjsDocumentManager.isDocActive(state)) {
      this.setConnectionState(keyString, "disconnected");
      return;
    }

    if (state.retryTimer !== undefined) {
      return;
    }

    if (state.retryAttempts >= this.liveEditingRetryConfig.maxRetries) {
      YjsDocumentManager.resetRetryState(state);
      this.setConnectionState(keyString, "disconnected");
      return;
    }

    const retryDelayMs = calculateRetryDelay(
      state.retryAttempts,
      this.liveEditingRetryConfig
    );
    state.retryAttempts += 1;
    this.setConnectionState(keyString, "connecting");
    state.retryTimer = setTimeout(() => {
      const currentState = this.docs.get(keyString);
      if (!currentState) {
        return;
      }

      currentState.retryTimer = undefined;

      if (!YjsDocumentManager.isDocActive(currentState)) {
        this.setConnectionState(keyString, "disconnected");
        return;
      }

      this.requestSyncStep1(docKey, keyString, currentState);
    }, retryDelayMs);
  }

  private attachLocalUpdateHandler(
    docKey: DocumentKey,
    keyString: string,
    state: DocumentState
  ): void {
    if (state.unsubscribe) {
      return;
    }

    const handler = (update: Uint8Array, origin: unknown) => {
      // Only process updates that originated locally.
      if (origin === this.remoteUpdateOrigin) {
        return;
      }

      this.persistDocument(keyString, state.doc);
      this.notifyContentChange(keyString);

      // During reconnect/syncing or transport outages, buffer local updates and
      // flush once we are connected again.
      if (
        state.connectionState === "connected" &&
        this.transport?.isConnected() === true
      ) {
        this.sendUpdate(docKey, update);
        return;
      }

      state.pendingLocalUpdates.push(update);
    };

    state.doc.on("update", handler);
    state.unsubscribe = () => {
      state.doc.off("update", handler);
    };
  }

  private static detachLocalUpdateHandler(state: DocumentState): void {
    state.unsubscribe?.();
    state.unsubscribe = undefined;
  }

  private static isDocActive(state: DocumentState): boolean {
    return state.refCount > 0;
  }

  private shouldApplyRemoteMessage(state: DocumentState): boolean {
    return (
      YjsDocumentManager.isDocActive(state) &&
      this.transport?.isConnected() === true
    );
  }

  private sendIfConnected(message: ClientMessage): void {
    if (this.transport?.isConnected()) {
      this.transport.send(message);
    }
  }

  private setConnectionState(
    keyString: string,
    state: DocumentConnectionState
  ): void {
    const docState = this.docs.get(keyString);
    if (docState) {
      docState.connectionState = state;
    }

    const callbacks = this.connectionStateCallbacks.get(keyString);
    if (callbacks) {
      for (const callback of callbacks) {
        // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
        callback(state);
      }
    }
  }

  private notifyContentChange(keyString: string): void {
    const callbacks = this.contentCallbacks.get(keyString);
    if (!callbacks) {
      return;
    }

    const docKey = fromDocumentKeyString(keyString);
    if (!docKey) {
      return;
    }

    const content = this.getDerivedContent(docKey);
    for (const callback of callbacks) {
      // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
      callback(content);
    }
  }

  private sendSyncStep1(docKey: DocumentKey): void {
    this.sendIfConnected({
      clientId: this.config.clientId,
      entityId: docKey.entityId,
      entityType: docKey.entityType,
      fieldName: docKey.fieldName,
      payload: base64Encode(this.getStateVector(docKey)),
      type: "yjs_sync_step1",
    });
  }

  private sendUpdate(docKey: DocumentKey, update: Uint8Array): void {
    this.sendIfConnected({
      clientId: this.config.clientId,
      connId: this.config.connId,
      entityId: docKey.entityId,
      entityType: docKey.entityType,
      fieldName: docKey.fieldName,
      payload: base64Encode(update),
      type: "yjs_update",
    });
  }

  private flushPendingLocalUpdates(
    docKey: DocumentKey,
    state: DocumentState
  ): void {
    if (state.pendingLocalUpdates.length === 0) {
      return;
    }

    const mergedUpdate = Y.mergeUpdates(state.pendingLocalUpdates);
    state.pendingLocalUpdates = [];
    this.sendUpdate(docKey, mergedUpdate);
  }

  private handleMessage(message: ServerMessage): void {
    if (isYjsSyncStep2Message(message)) {
      this.handleSyncStep2(message);
    } else if (isYjsUpdateMessage(message)) {
      this.handleUpdate(message);
    } else if (isLiveEditingErrorMessage(message)) {
      this.handleError(message);
    }
  }

  private handleSyncStep2(message: YjsSyncStep2Message): void {
    const keyString = toDocumentKeyString(message);
    const state = this.docs.get(keyString);

    if (!(state && this.shouldApplyRemoteMessage(state))) {
      return;
    }

    if (message.seq < state.lastSeq) {
      return;
    }

    if (
      message.seq === state.lastSeq &&
      state.connectionState === "connected"
    ) {
      return;
    }

    const update = base64Decode(message.payload);
    Y.applyUpdate(state.doc, update, this.remoteUpdateOrigin);

    state.lastSeq = message.seq;
    YjsDocumentManager.resetRetryState(state);

    this.persistDocument(keyString, state.doc);
    this.flushPendingLocalUpdates(message, state);
    this.setConnectionState(keyString, "connected");
    this.notifyContentChange(keyString);
  }

  private handleUpdate(message: YjsUpdateMessage): void {
    // Ignore updates echoed to the same live connection.
    if (message.connId === this.config.connId) {
      return;
    }

    const keyString = toDocumentKeyString(message);
    const state = this.docs.get(keyString);

    if (!(state && this.shouldApplyRemoteMessage(state))) {
      return;
    }

    if (state.connectionState !== "connected") {
      return;
    }

    if (message.seq <= state.lastSeq) {
      return;
    }

    const expectedSeq = state.lastSeq + 1;
    if (message.seq > expectedSeq) {
      this.requestSyncStep1(message, keyString, state);
      return;
    }

    const update = base64Decode(message.payload);
    Y.applyUpdate(state.doc, update, this.remoteUpdateOrigin);
    state.lastSeq = message.seq;

    this.persistDocument(keyString, state.doc);
    this.notifyContentChange(keyString);
  }

  private handleError(message: LiveEditingErrorMessage): void {
    const keyString = toDocumentKeyString(message);
    const state = this.docs.get(keyString);

    if (!state) {
      return;
    }

    if (!isRetryableLiveEditingErrorCode(message.code)) {
      YjsDocumentManager.resetRetryState(state);
      this.setConnectionState(keyString, "disconnected");
      return;
    }

    this.scheduleRetrySyncStep1(message, keyString, state);
  }

  private getPersistedDocumentKey(keyString: string): string {
    return `${this.persistenceKeyPrefix}${keyString}`;
  }

  private restorePersistedDocument(keyString: string, doc: Y.Doc): void {
    if (typeof localStorage === "undefined") {
      return;
    }

    try {
      const encodedUpdate = localStorage.getItem(
        this.getPersistedDocumentKey(keyString)
      );
      if (!encodedUpdate) {
        return;
      }

      const update = base64Decode(encodedUpdate);
      Y.applyUpdate(doc, update, this.remoteUpdateOrigin);
    } catch {
      // Ignore persistence read errors and continue with empty document state.
    }
  }

  private persistDocument(keyString: string, doc: Y.Doc): void {
    if (typeof localStorage === "undefined") {
      return;
    }

    try {
      const encodedUpdate = base64Encode(Y.encodeStateAsUpdate(doc));
      localStorage.setItem(
        this.getPersistedDocumentKey(keyString),
        encodedUpdate
      );
    } catch {
      // Ignore persistence write errors (e.g. quota exceeded) and keep syncing.
    }
  }
}

// Base64 encoding/decoding utilities
const base64Encode = (data: Uint8Array): string => {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(data).toString("base64");
  }

  if (typeof btoa === "function") {
    let binary = "";
    for (const byte of data) {
      binary += String.fromCodePoint(byte);
    }
    return btoa(binary);
  }

  throw new Error("No base64 encoder available");
};

const base64Decode = (str: string): Uint8Array => {
  if (typeof atob === "function") {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.codePointAt(i) as number;
    }
    return bytes;
  }
  return new Uint8Array(Buffer.from(str, "base64"));
};

const normalizeRetryConfig = (
  retryConfig: Partial<LiveEditingRetryConfig> | undefined
): LiveEditingRetryConfig => {
  const baseDelayMs = Math.max(
    1,
    retryConfig?.baseDelayMs ?? DEFAULT_LIVE_EDITING_RETRY_CONFIG.baseDelayMs
  );
  const maxDelayMs = Math.max(
    baseDelayMs,
    retryConfig?.maxDelayMs ?? DEFAULT_LIVE_EDITING_RETRY_CONFIG.maxDelayMs
  );
  const maxRetries = Math.max(
    0,
    retryConfig?.maxRetries ?? DEFAULT_LIVE_EDITING_RETRY_CONFIG.maxRetries
  );
  const jitter = clamp(
    retryConfig?.jitter ?? DEFAULT_LIVE_EDITING_RETRY_CONFIG.jitter,
    0,
    1
  );

  return {
    baseDelayMs,
    jitter,
    maxDelayMs,
    maxRetries,
  };
};

const calculateRetryDelay = (
  attempt: number,
  config: LiveEditingRetryConfig
): number => {
  const exponentialDelay = config.baseDelayMs * 2 ** attempt;
  const clampedDelay = Math.min(exponentialDelay, config.maxDelayMs);

  if (config.jitter <= 0) {
    return clampedDelay;
  }

  const jitterWindow = clampedDelay * config.jitter;
  const jitteredDelay = clampedDelay + (Math.random() * 2 - 1) * jitterWindow;
  return Math.max(0, Math.round(jitteredDelay));
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));
