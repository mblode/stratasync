// biome-ignore lint/performance/noNamespaceImport: yjs conventionally uses namespace access (Y.Doc, etc.)
import * as Y from "yjs";

import { YjsDocumentManager } from "../src/document-manager";
import { createPersistedYjsPrefix } from "../src/persistence";
import { fromDocumentKeyString, toDocumentKeyString } from "../src/types";
import type { DocumentKey } from "../src/types";
import { createMockTransport } from "./mock-transport";

const PROSEMIRROR_FIELD = "prosemirror";

const setProsemirrorContent = (doc: Y.Doc, content: string): void => {
  const fragment = doc.getXmlFragment(PROSEMIRROR_FIELD);
  if (fragment.length > 0) {
    fragment.delete(0, fragment.length);
  }

  if (content.length === 0) {
    return;
  }

  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  text.insert(0, content);
  paragraph.insert(0, [text]);
  fragment.insert(0, [paragraph]);
};

const createXmlText = (content: string): Y.XmlText => {
  const text = new Y.XmlText();
  text.insert(0, content);
  return text;
};

const createXmlElement = (
  nodeName: string,
  attributes: Record<string, string> = {},
  children: (Y.XmlElement | Y.XmlText)[] = []
): Y.XmlElement => {
  const element = new Y.XmlElement(nodeName);

  for (const [attributeName, value] of Object.entries(attributes)) {
    element.setAttribute(attributeName, value);
  }

  if (children.length > 0) {
    element.insert(0, children);
  }

  return element;
};

const setProsemirrorNodes = (
  doc: Y.Doc,
  nodes: (Y.XmlElement | Y.XmlText)[]
): void => {
  const fragment = doc.getXmlFragment(PROSEMIRROR_FIELD);
  if (fragment.length > 0) {
    fragment.delete(0, fragment.length);
  }

  if (nodes.length === 0) {
    return;
  }

  fragment.insert(0, nodes);
};

const getProsemirrorText = (doc: Y.Doc): string => {
  const fragment = doc.getXmlFragment(PROSEMIRROR_FIELD);

  const readNode = (node: Y.XmlElement | Y.XmlText): string => {
    if (node instanceof Y.XmlText) {
      return node.toString();
    }

    return node
      .toArray()
      .map((child) =>
        child instanceof Y.XmlElement || child instanceof Y.XmlText
          ? readNode(child)
          : ""
      )
      .join("");
  };

  return fragment
    .toArray()
    .map((node) =>
      node instanceof Y.XmlElement || node instanceof Y.XmlText
        ? readNode(node)
        : ""
    )
    .join("\n")
    .trim();
};

const createLocalStorageMock = () => {
  const store = new Map<string, string>();

  return {
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
    get length() {
      return store.size;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
};

describe(YjsDocumentManager, () => {
  let manager: YjsDocumentManager;
  let transport: ReturnType<typeof createMockTransport>;

  const testDocKey: DocumentKey = {
    entityId: "test-task-123",
    entityType: "Task",
    fieldName: "description",
  };

  beforeEach(() => {
    vi.stubGlobal("localStorage", createLocalStorageMock());
    transport = createMockTransport();
    manager = new YjsDocumentManager({
      clientId: "test-client",
      connId: "test-conn",
    });
    manager.setTransport(transport);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("getDocument", () => {
    it("should create a new Y.Doc for a document key", () => {
      const doc = manager.getDocument(testDocKey);

      expect(doc).toBeInstanceOf(Y.Doc);
    });

    it("should return the same Y.Doc for repeated calls", () => {
      const doc1 = manager.getDocument(testDocKey);
      const doc2 = manager.getDocument(testDocKey);

      expect(doc1).toBe(doc2);
    });

    it("should return different Y.Docs for different keys", () => {
      const doc1 = manager.getDocument(testDocKey);
      const doc2 = manager.getDocument({
        ...testDocKey,
        entityId: "different-id",
      });

      expect(doc1).not.toBe(doc2);
    });
  });

  describe("connect", () => {
    it("should send yjs_sync_step1 message with state vector", () => {
      manager.connect(testDocKey);

      const syncMessage = transport.sentMessages.find(
        (m) => m.type === "yjs_sync_step1"
      );
      expect(syncMessage).toBeDefined();
      expect(syncMessage).toMatchObject({
        clientId: "test-client",
        entityId: "test-task-123",
        entityType: "Task",
        fieldName: "description",
        type: "yjs_sync_step1",
      });
    });

    it("should seed initial content immediately for instant rendering", () => {
      manager.connect(testDocKey, { initialContent: "Hello, world!" });

      // Content is available immediately. No need to wait for sync step 2.
      expect(manager.getDerivedContent(testDocKey)).toBe("Hello, world!");

      // Content survives an empty sync step 2 from the server.
      const emptyServerDoc = new Y.Doc();
      const update = Y.encodeStateAsUpdate(emptyServerDoc);

      transport.triggerMessage({
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(update).toString("base64"),
        seq: 1,
        type: "yjs_sync_step2",
      });

      expect(manager.getDerivedContent(testDocKey)).toBe("Hello, world!");
    });

    it("uploads seeded initial content after the initial sync handshake", () => {
      manager.connect(testDocKey, { initialContent: "Hello, world!" });

      expect(
        transport.sentMessages.filter(
          (message) => message.type === "yjs_update"
        )
      ).toHaveLength(0);

      const emptyServerDoc = new Y.Doc();
      transport.triggerMessage({
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(Y.encodeStateAsUpdate(emptyServerDoc)).toString(
          "base64"
        ),
        seq: 1,
        type: "yjs_sync_step2",
      });

      const updateMessage = transport.sentMessages.find(
        (message) => message.type === "yjs_update"
      );
      expect(updateMessage).toBeDefined();

      const serverDoc = new Y.Doc();
      Y.applyUpdate(
        serverDoc,
        Buffer.from(updateMessage?.payload ?? "", "base64")
      );
      expect(getProsemirrorText(serverDoc)).toBe("Hello, world!");
    });

    it("uploads pre-connect document changes after the initial sync handshake", () => {
      const doc = manager.getDocument(testDocKey);
      setProsemirrorContent(doc, "Pre-connect change");

      manager.connect(testDocKey);

      const emptyServerDoc = new Y.Doc();
      transport.triggerMessage({
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(Y.encodeStateAsUpdate(emptyServerDoc)).toString(
          "base64"
        ),
        seq: 1,
        type: "yjs_sync_step2",
      });

      const updateMessage = transport.sentMessages.find(
        (message) => message.type === "yjs_update"
      );
      expect(updateMessage).toBeDefined();

      const serverDoc = new Y.Doc();
      Y.applyUpdate(
        serverDoc,
        Buffer.from(updateMessage?.payload ?? "", "base64")
      );
      expect(getProsemirrorText(serverDoc)).toBe("Pre-connect change");
    });

    it("should set connection state to syncing while waiting for sync step 2", () => {
      manager.connect(testDocKey);

      expect(manager.getConnectionState(testDocKey)).toBe("syncing");
    });
  });

  describe("disconnect", () => {
    it("should use refcount semantics (first connect attaches, final disconnect detaches)", () => {
      manager.connect(testDocKey);
      manager.connect(testDocKey);

      const syncMessagesAfterConnect = transport.sentMessages.filter(
        (message) => message.type === "yjs_sync_step1"
      );
      expect(syncMessagesAfterConnect).toHaveLength(1);

      const serverDoc = new Y.Doc();
      const serverSnapshot = Y.encodeStateAsUpdate(serverDoc);
      transport.triggerMessage({
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(serverSnapshot).toString("base64"),
        seq: 1,
        type: "yjs_sync_step2",
      });

      const doc = manager.getDocument(testDocKey);

      manager.disconnect(testDocKey);
      setProsemirrorContent(doc, "still attached");

      const updatesAfterFirstDisconnect = transport.sentMessages.filter(
        (message) => message.type === "yjs_update"
      );
      expect(updatesAfterFirstDisconnect).toHaveLength(1);

      manager.disconnect(testDocKey);
      setProsemirrorContent(doc, "detached");

      const updatesAfterFinalDisconnect = transport.sentMessages.filter(
        (message) => message.type === "yjs_update"
      );
      expect(updatesAfterFinalDisconnect).toHaveLength(1);
    });

    it("should set connection state to disconnected", () => {
      manager.connect(testDocKey);
      manager.disconnect(testDocKey);

      expect(manager.getConnectionState(testDocKey)).toBe("disconnected");
    });
  });

  describe("remote updates", () => {
    it("should apply sync step 2 and set connected state", () => {
      manager.connect(testDocKey);

      // Create a Y.Doc with some content to simulate server state
      const serverDoc = new Y.Doc();
      setProsemirrorContent(serverDoc, "Server content");
      const update = Y.encodeStateAsUpdate(serverDoc);

      // Send sync step 2
      transport.triggerMessage({
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(update).toString("base64"),
        seq: 1,
        type: "yjs_sync_step2",
      });

      expect(manager.getConnectionState(testDocKey)).toBe("connected");
      expect(manager.getDerivedContent(testDocKey)).toBe("Server content");
    });

    it("should merge server content over pre-seeded initial content", () => {
      manager.connect(testDocKey, { initialContent: "Local initial content" });

      // Initial content is seeded immediately
      expect(manager.getDerivedContent(testDocKey)).toBe(
        "Local initial content"
      );

      // Server sends its content via sync step 2
      const serverDoc = new Y.Doc();
      setProsemirrorContent(serverDoc, "Server content");
      const update = Y.encodeStateAsUpdate(serverDoc);

      transport.triggerMessage({
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(update).toString("base64"),
        seq: 1,
        type: "yjs_sync_step2",
      });

      // Server content is present after CRDT merge
      const content = manager.getDerivedContent(testDocKey);
      expect(content).toContain("Server content");
    });

    it("should apply remote updates", () => {
      manager.connect(testDocKey);

      const serverDoc = new Y.Doc();
      const serverSnapshot = Y.encodeStateAsUpdate(serverDoc);
      transport.triggerMessage({
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(serverSnapshot).toString("base64"),
        seq: 1,
        type: "yjs_sync_step2",
      });

      // Create an update
      const updateDoc = new Y.Doc();
      setProsemirrorContent(updateDoc, "Updated");
      const update = Y.encodeStateAsUpdate(updateDoc);

      transport.triggerMessage({
        clientId: "other-client",
        connId: "other-conn",
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(update).toString("base64"),
        seq: 2,
        type: "yjs_update",
      });

      // The update should be applied
      const content = manager.getDerivedContent(testDocKey);
      expect(content).toContain("Updated");
    });

    it("should ignore echoed updates from the same connection", () => {
      manager.connect(testDocKey);

      const serverDoc = new Y.Doc();
      const serverSnapshot = Y.encodeStateAsUpdate(serverDoc);
      transport.triggerMessage({
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(serverSnapshot).toString("base64"),
        seq: 1,
        type: "yjs_sync_step2",
      });

      const updateDoc = new Y.Doc();
      setProsemirrorContent(updateDoc, "Self update");
      const update = Y.encodeStateAsUpdate(updateDoc);

      transport.triggerMessage({
        clientId: "another-client",
        // Same as manager's connId
        connId: "test-conn",
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(update).toString("base64"),
        seq: 2,
        type: "yjs_update",
      });

      // Content should remain unchanged
      expect(manager.getDerivedContent(testDocKey)).toBe("");
    });

    it("should apply updates from same clientId when connId differs", () => {
      manager.connect(testDocKey);

      const serverDoc = new Y.Doc();
      const serverSnapshot = Y.encodeStateAsUpdate(serverDoc);
      transport.triggerMessage({
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(serverSnapshot).toString("base64"),
        seq: 1,
        type: "yjs_sync_step2",
      });

      const updateDoc = new Y.Doc();
      setProsemirrorContent(updateDoc, "From another tab");
      const update = Y.encodeStateAsUpdate(updateDoc);

      transport.triggerMessage({
        clientId: "test-client",
        connId: "other-conn",
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(update).toString("base64"),
        seq: 2,
        type: "yjs_update",
      });

      expect(manager.getDerivedContent(testDocKey)).toBe("From another tab");
    });

    it("should drop duplicate and stale seq updates", () => {
      manager.connect(testDocKey);

      const serverDoc = new Y.Doc();
      const serverSnapshot = Y.encodeStateAsUpdate(serverDoc);
      transport.triggerMessage({
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(serverSnapshot).toString("base64"),
        seq: 1,
        type: "yjs_sync_step2",
      });

      const updateDocA = new Y.Doc();
      setProsemirrorContent(updateDocA, "A");
      const updateA = Y.encodeStateAsUpdate(updateDocA);
      transport.triggerMessage({
        clientId: "other-client",
        connId: "other-conn",
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(updateA).toString("base64"),
        seq: 2,
        type: "yjs_update",
      });
      expect(manager.getDerivedContent(testDocKey)).toBe("A");

      const updateDocB = new Y.Doc();
      setProsemirrorContent(updateDocB, "B");
      const updateB = Y.encodeStateAsUpdate(updateDocB);
      transport.triggerMessage({
        clientId: "other-client",
        connId: "other-conn",
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(updateB).toString("base64"),
        seq: 2,
        type: "yjs_update",
      });
      transport.triggerMessage({
        clientId: "other-client",
        connId: "other-conn",
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(updateB).toString("base64"),
        seq: 1,
        type: "yjs_update",
      });

      expect(manager.getDerivedContent(testDocKey)).toBe("A");
    });

    it("should request resync when update sequence has a gap", () => {
      manager.connect(testDocKey);

      const serverDoc = new Y.Doc();
      const serverSnapshot = Y.encodeStateAsUpdate(serverDoc);
      transport.triggerMessage({
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(serverSnapshot).toString("base64"),
        seq: 1,
        type: "yjs_sync_step2",
      });

      const updateDoc = new Y.Doc();
      setProsemirrorContent(updateDoc, "gap");
      const update = Y.encodeStateAsUpdate(updateDoc);
      transport.triggerMessage({
        clientId: "other-client",
        connId: "other-conn",
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(update).toString("base64"),
        seq: 3,
        type: "yjs_update",
      });

      const syncMessages = transport.sentMessages.filter(
        (message) => message.type === "yjs_sync_step1"
      );
      expect(syncMessages).toHaveLength(2);
      expect(manager.getConnectionState(testDocKey)).toBe("syncing");
      expect(manager.getDerivedContent(testDocKey)).toBe("");
    });

    it("ignores malformed sync-step2 payloads without breaking later messages", () => {
      manager.connect(testDocKey);

      expect(() =>
        transport.triggerMessage({
          entityId: testDocKey.entityId,
          entityType: testDocKey.entityType,
          fieldName: testDocKey.fieldName,
          payload: "%%%not-base64%%%",
          seq: 1,
          type: "yjs_sync_step2",
        })
      ).not.toThrow();
      expect(() =>
        transport.triggerMessage({
          entityId: testDocKey.entityId,
          entityType: testDocKey.entityType,
          fieldName: testDocKey.fieldName,
          payload: "",
          seq: 1,
          type: "yjs_sync_step2",
        })
      ).not.toThrow();

      const serverDoc = new Y.Doc();
      setProsemirrorContent(serverDoc, "Recovered");
      transport.triggerMessage({
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(Y.encodeStateAsUpdate(serverDoc)).toString(
          "base64"
        ),
        seq: 1,
        type: "yjs_sync_step2",
      });

      expect(manager.getConnectionState(testDocKey)).toBe("connected");
      expect(manager.getDerivedContent(testDocKey)).toBe("Recovered");
    });

    it("should replay sync_step1 for active docs when transport reconnects", async () => {
      manager.connect(testDocKey);

      const initialSyncMessages = transport.sentMessages.filter(
        (message) => message.type === "yjs_sync_step1"
      );
      expect(initialSyncMessages).toHaveLength(1);

      transport.triggerConnectionState("disconnected");
      expect(manager.getConnectionState(testDocKey)).toBe("connecting");

      transport.triggerConnectionState("connected");
      await Promise.resolve();

      const syncMessagesAfterReconnect = transport.sentMessages.filter(
        (message) => message.type === "yjs_sync_step1"
      );
      expect(syncMessagesAfterReconnect).toHaveLength(2);
      expect(manager.getConnectionState(testDocKey)).toBe("syncing");
    });

    it("should ignore stale updates while transport is not connected", () => {
      manager.connect(testDocKey);

      const serverDoc = new Y.Doc();
      const serverSnapshot = Y.encodeStateAsUpdate(serverDoc);
      transport.triggerMessage({
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(serverSnapshot).toString("base64"),
        seq: 1,
        type: "yjs_sync_step2",
      });

      transport.triggerConnectionState("disconnected");

      const updateDoc = new Y.Doc();
      setProsemirrorContent(updateDoc, "ignored");
      const update = Y.encodeStateAsUpdate(updateDoc);
      transport.triggerMessage({
        clientId: "other-client",
        connId: "other-conn",
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(update).toString("base64"),
        seq: 2,
        type: "yjs_update",
      });

      expect(manager.getDerivedContent(testDocKey)).toBe("");
    });

    it("ignores malformed update payloads without breaking later updates", () => {
      manager.connect(testDocKey);

      const serverDoc = new Y.Doc();
      transport.triggerMessage({
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(Y.encodeStateAsUpdate(serverDoc)).toString(
          "base64"
        ),
        seq: 1,
        type: "yjs_sync_step2",
      });

      expect(() =>
        transport.triggerMessage({
          clientId: "other-client",
          connId: "other-conn",
          entityId: testDocKey.entityId,
          entityType: testDocKey.entityType,
          fieldName: testDocKey.fieldName,
          payload: "%%%not-base64%%%",
          seq: 2,
          type: "yjs_update",
        })
      ).not.toThrow();
      expect(() =>
        transport.triggerMessage({
          clientId: "other-client",
          connId: "other-conn",
          entityId: testDocKey.entityId,
          entityType: testDocKey.entityType,
          fieldName: testDocKey.fieldName,
          payload: "",
          seq: 2,
          type: "yjs_update",
        })
      ).not.toThrow();

      const updateDoc = new Y.Doc();
      setProsemirrorContent(updateDoc, "Recovered update");
      transport.triggerMessage({
        clientId: "other-client",
        connId: "other-conn",
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(Y.encodeStateAsUpdate(updateDoc)).toString(
          "base64"
        ),
        seq: 2,
        type: "yjs_update",
      });

      expect(manager.getDerivedContent(testDocKey)).toBe("Recovered update");
    });
  });

  describe("persisted state", () => {
    it("restores persisted state only for the configured namespace", () => {
      const scopedPrefix = createPersistedYjsPrefix("scope-a");
      manager.setPersistenceKeyPrefix(scopedPrefix);
      manager.getDocument(testDocKey);

      const persistedDoc = new Y.Doc();
      setProsemirrorContent(persistedDoc, "Scoped content");
      manager.applyRemoteUpdate(
        testDocKey,
        Y.encodeStateAsUpdate(persistedDoc)
      );

      const restoredManager = new YjsDocumentManager({
        clientId: "test-client",
        connId: "test-conn",
        persistenceKeyPrefix: scopedPrefix,
      });
      restoredManager.getDocument(testDocKey);
      expect(restoredManager.getDerivedContent(testDocKey)).toBe(
        "Scoped content"
      );

      const isolatedManager = new YjsDocumentManager({
        clientId: "test-client",
        connId: "test-conn",
        persistenceKeyPrefix: createPersistedYjsPrefix("scope-b"),
      });
      isolatedManager.getDocument(testDocKey);
      expect(isolatedManager.getDerivedContent(testDocKey)).toBe("");
    });

    it("clears only the active persistence namespace", () => {
      const localStorageMock = globalThis.localStorage;
      localStorageMock.setItem(
        `${createPersistedYjsPrefix("scope-a")}Task:a:description`,
        "value-a"
      );
      localStorageMock.setItem(
        `${createPersistedYjsPrefix("scope-b")}Task:b:description`,
        "value-b"
      );

      manager.setPersistenceKeyPrefix(createPersistedYjsPrefix("scope-a"));
      manager.clearPersistedDocuments();

      expect(
        localStorageMock.getItem(
          `${createPersistedYjsPrefix("scope-a")}Task:a:description`
        )
      ).toBeNull();
      expect(
        localStorageMock.getItem(
          `${createPersistedYjsPrefix("scope-b")}Task:b:description`
        )
      ).toBe("value-b");
    });
  });

  describe("derived content", () => {
    it("includes image placeholders for inline and block image nodes", () => {
      const doc = manager.getDocument(testDocKey);
      setProsemirrorNodes(doc, [
        createXmlElement("paragraph", {}, [
          createXmlText("Before "),
          createXmlElement("taskImage", {
            src: "https://cdn.test/inline.webp",
          }),
          createXmlText(" after"),
        ]),
        createXmlElement("imageBlock", {
          alt: "Roadmap screenshot",
          src: "https://cdn.test/block.webp",
        }),
        createXmlElement("imageBlock", { src: "https://cdn.test/empty.webp" }),
      ]);

      expect(manager.getDerivedContent(testDocKey)).toBe(
        "Before ![Image](https://cdn.test/inline.webp) after\n\n![Roadmap screenshot](https://cdn.test/block.webp)\n\n![Image](https://cdn.test/empty.webp)"
      );
    });

    it("strips link marks from text nodes instead of rendering HTML tags", () => {
      const doc = manager.getDocument(testDocKey);
      const paragraph = createXmlElement("paragraph");
      const text = new Y.XmlText();
      text.insert(0, "https://example.com");
      text.format(0, 19, {
        link: { class: "text-primary underline", href: "https://example.com" },
      });
      paragraph.insert(0, [text]);
      setProsemirrorNodes(doc, [paragraph]);

      expect(manager.getDerivedContent(testDocKey)).toBe("https://example.com");
    });

    it("extracts plain text from mixed formatted and unformatted content", () => {
      const doc = manager.getDocument(testDocKey);
      const paragraph = createXmlElement("paragraph");
      const text = new Y.XmlText();
      text.insert(0, "Check out https://example.com for details");
      text.format(10, 19, {
        link: { href: "https://example.com" },
      });
      paragraph.insert(0, [text]);
      setProsemirrorNodes(doc, [paragraph]);

      expect(manager.getDerivedContent(testDocKey)).toBe(
        "Check out https://example.com for details"
      );
    });

    it("includes embed metadata in derived content while keeping plain text readable", () => {
      const doc = manager.getDocument(testDocKey);
      setProsemirrorNodes(doc, [
        createXmlElement("paragraph", {}, [createXmlText("Intro")]),
        createXmlElement("taskEmbed", {
          provider: "Loom",
          title: "Sprint review",
          url: "https://loom.com/share/123",
        }),
        createXmlElement("iframelyEmbed", {
          description: "A useful preview",
          src: "https://example.com/embed/abc",
        }),
      ]);

      expect(manager.getDerivedContent(testDocKey)).toBe(
        "Intro\n\n[Embed: Sprint review - Loom - https://loom.com/share/123]\n\n[Embed: A useful preview - https://example.com/embed/abc]"
      );
    });

    it("preserves long image urls in derived content", () => {
      const doc = manager.getDocument(testDocKey);
      const longUrl = `https://cdn.test/${"a".repeat(220)}`;
      setProsemirrorNodes(doc, [
        createXmlElement("imageBlock", {
          alt: "Hero image",
          src: longUrl,
        }),
      ]);

      expect(manager.getDerivedContent(testDocKey)).toBe(
        `![Hero image](${longUrl})`
      );
    });
  });

  describe("live editing errors", () => {
    it("retries sync step 1 with bounded exponential backoff", () => {
      vi.useFakeTimers();
      transport = createMockTransport();
      manager = new YjsDocumentManager({
        clientId: "test-client",
        connId: "test-conn",
        liveEditingRetry: {
          baseDelayMs: 100,
          jitter: 0,
          maxDelayMs: 200,
          maxRetries: 2,
        },
      });
      manager.setTransport(transport);

      manager.connect(testDocKey);

      const serverDoc = new Y.Doc();
      const snapshot = Y.encodeStateAsUpdate(serverDoc);
      transport.triggerMessage({
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(snapshot).toString("base64"),
        seq: 1,
        type: "yjs_sync_step2",
      });

      transport.sentMessages.length = 0;

      const triggerRetryableError = () => {
        transport.triggerMessage({
          code: "SUBSCRIBE_REQUIRED",
          entityId: testDocKey.entityId,
          entityType: testDocKey.entityType,
          error: "subscription required",
          fieldName: testDocKey.fieldName,
          type: "live_editing_error",
        });
      };
      const syncStep1Count = () =>
        transport.sentMessages.filter(
          (message) => message.type === "yjs_sync_step1"
        ).length;

      triggerRetryableError();
      expect(manager.getConnectionState(testDocKey)).toBe("connecting");
      expect(syncStep1Count()).toBe(0);

      vi.advanceTimersByTime(99);
      expect(syncStep1Count()).toBe(0);

      vi.advanceTimersByTime(1);
      expect(syncStep1Count()).toBe(1);
      expect(manager.getConnectionState(testDocKey)).toBe("syncing");

      triggerRetryableError();
      vi.advanceTimersByTime(199);
      expect(syncStep1Count()).toBe(1);

      vi.advanceTimersByTime(1);
      expect(syncStep1Count()).toBe(2);

      triggerRetryableError();
      vi.runOnlyPendingTimers();
      expect(syncStep1Count()).toBe(2);
      expect(manager.getConnectionState(testDocKey)).toBe("disconnected");
    });
  });

  describe("local updates", () => {
    it("should send updates when document changes", () => {
      manager.connect(testDocKey);

      const serverDoc = new Y.Doc();
      const serverSnapshot = Y.encodeStateAsUpdate(serverDoc);
      transport.triggerMessage({
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(serverSnapshot).toString("base64"),
        seq: 1,
        type: "yjs_sync_step2",
      });

      const doc = manager.getDocument(testDocKey);
      setProsemirrorContent(doc, "Local change");

      // Check that update was sent
      const updateMessage = transport.sentMessages.find(
        (m) => m.type === "yjs_update"
      );
      expect(updateMessage).toBeDefined();
      expect(updateMessage).toMatchObject({
        clientId: "test-client",
        connId: "test-conn",
        entityId: "test-task-123",
        entityType: "Task",
        fieldName: "description",
        type: "yjs_update",
      });
    });

    it("should buffer local updates while disconnected and flush after sync", () => {
      manager.connect(testDocKey);

      const serverDoc = new Y.Doc();
      const serverSnapshot = Y.encodeStateAsUpdate(serverDoc);
      transport.triggerMessage({
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(serverSnapshot).toString("base64"),
        seq: 1,
        type: "yjs_sync_step2",
      });

      const initialUpdateCount = transport.sentMessages.filter(
        (m) => m.type === "yjs_update"
      ).length;

      transport.triggerConnectionState("disconnected");
      const doc = manager.getDocument(testDocKey);
      setProsemirrorContent(doc, "Offline change");

      const updateCountWhileDisconnected = transport.sentMessages.filter(
        (m) => m.type === "yjs_update"
      ).length;
      expect(updateCountWhileDisconnected).toBe(initialUpdateCount);

      transport.triggerConnectionState("connected");
      transport.triggerMessage({
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(serverSnapshot).toString("base64"),
        seq: 1,
        type: "yjs_sync_step2",
      });

      const updateCountAfterReconnect = transport.sentMessages.filter(
        (m) => m.type === "yjs_update"
      ).length;
      expect(updateCountAfterReconnect).toBe(initialUpdateCount + 1);
    });
  });

  describe("callbacks", () => {
    it("should notify connection state callbacks", () => {
      const callback = vi.fn();
      manager.onConnectionStateChange(testDocKey, callback);

      expect(callback).toHaveBeenCalledWith("disconnected");

      manager.connect(testDocKey);
      expect(callback).toHaveBeenCalledWith("syncing");
    });

    it("should notify content callbacks on remote update", () => {
      const callback = vi.fn();
      manager.connect(testDocKey);
      manager.onContentChange(testDocKey, callback);

      // Initial call with current content
      expect(callback).toHaveBeenCalledWith("");

      const serverDoc = new Y.Doc();
      const serverSnapshot = Y.encodeStateAsUpdate(serverDoc);
      transport.triggerMessage({
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(serverSnapshot).toString("base64"),
        seq: 1,
        type: "yjs_sync_step2",
      });

      // Remote update
      const updateDoc = new Y.Doc();
      setProsemirrorContent(updateDoc, "New");
      const update = Y.encodeStateAsUpdate(updateDoc);

      transport.triggerMessage({
        clientId: "other-client",
        connId: "other-conn",
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        fieldName: testDocKey.fieldName,
        payload: Buffer.from(update).toString("base64"),
        seq: 2,
        type: "yjs_update",
      });

      expect(callback).toHaveBeenCalledTimes(3);
    });

    it("should allow unsubscription from callbacks", () => {
      const callback = vi.fn();
      const unsubscribe = manager.onConnectionStateChange(testDocKey, callback);

      callback.mockClear();
      unsubscribe();

      manager.connect(testDocKey);
      expect(callback).not.toHaveBeenCalled();
    });

    it("cleans up empty callback sets on unsubscribe", () => {
      const connectionUnsubscribe = manager.onConnectionStateChange(
        testDocKey,
        vi.fn()
      );
      const contentUnsubscribe = manager.onContentChange(testDocKey, vi.fn());

      connectionUnsubscribe();
      contentUnsubscribe();

      const callbackState = manager as unknown as {
        connectionStateCallbacks: Map<string, Set<unknown>>;
        contentCallbacks: Map<string, Set<unknown>>;
      };

      expect(callbackState.connectionStateCallbacks.size).toBe(0);
      expect(callbackState.contentCallbacks.size).toBe(0);
    });
  });

  describe("destroy", () => {
    it("should clean up document and callbacks", () => {
      const callback = vi.fn();
      manager.connect(testDocKey);
      manager.onConnectionStateChange(testDocKey, callback);

      callback.mockClear();
      manager.destroy(testDocKey);

      // Getting document again should return new instance
      manager.connect(testDocKey);
      // Callback should not be called since it was cleaned up
    });

    it("destroyAll should clean up all documents", () => {
      manager.connect(testDocKey);
      manager.connect({ ...testDocKey, entityId: "other-id" });

      manager.destroyAll();

      expect(manager.getConnectionState(testDocKey)).toBe("disconnected");
      expect(
        manager.getConnectionState({ ...testDocKey, entityId: "other-id" })
      ).toBe("disconnected");
    });

    it("destroyAll cleans up documents with encoded key segments", () => {
      const colonDocKey: DocumentKey = {
        entityId: "task:123",
        entityType: "Task",
        fieldName: "body:markdown",
      };
      const doc = manager.getDocument(colonDocKey);

      manager.destroyAll();

      expect(manager.getDocument(colonDocKey)).not.toBe(doc);
    });
  });

  describe("state vector and updates", () => {
    it("should return state vector", () => {
      manager.connect(testDocKey, { initialContent: "Test" });

      const stateVector = manager.getStateVector(testDocKey);
      expect(stateVector).toBeInstanceOf(Uint8Array);
      expect(stateVector.length).toBeGreaterThan(0);
    });

    it("should return null for empty updates", () => {
      const doc = manager.getDocument(testDocKey);
      const stateVector = Y.encodeStateVector(doc);

      const updates = manager.getUpdatesSince(testDocKey, stateVector);
      expect(updates).toBeNull();
    });

    it("should return encoded state", () => {
      manager.connect(testDocKey, { initialContent: "Test" });

      const state = manager.getEncodedState(testDocKey);
      expect(state).toBeInstanceOf(Uint8Array);
      expect(state?.length).toBeGreaterThan(0);
    });
  });

  describe("document key helpers", () => {
    it("round-trips keys containing reserved characters", () => {
      const docKey: DocumentKey = {
        entityId: "tenant:123/alpha",
        entityType: "Task%Board",
        fieldName: "body:markdown",
      };

      expect(fromDocumentKeyString(toDocumentKeyString(docKey))).toEqual(
        docKey
      );
    });

    it("supports content callbacks for keys containing colons", () => {
      const docKey: DocumentKey = {
        entityId: "task:123",
        entityType: "Task",
        fieldName: "body:markdown",
      };
      const callback = vi.fn();
      manager.onContentChange(docKey, callback);
      manager.connect(docKey);

      const serverDoc = new Y.Doc();
      setProsemirrorContent(serverDoc, "Encoded key content");
      transport.triggerMessage({
        entityId: docKey.entityId,
        entityType: docKey.entityType,
        fieldName: docKey.fieldName,
        payload: Buffer.from(Y.encodeStateAsUpdate(serverDoc)).toString(
          "base64"
        ),
        seq: 1,
        type: "yjs_sync_step2",
      });

      expect(callback).toHaveBeenLastCalledWith("Encoded key content");
    });
  });

  describe("terminal live editing errors", () => {
    it("allows reconnect after a non-retryable error", () => {
      manager.connect(testDocKey);

      transport.triggerMessage({
        code: "RATE_LIMITED",
        entityId: testDocKey.entityId,
        entityType: testDocKey.entityType,
        error: "rate limited",
        fieldName: testDocKey.fieldName,
        type: "live_editing_error",
      });

      expect(manager.getConnectionState(testDocKey)).toBe("disconnected");

      manager.connect(testDocKey);

      const syncMessages = transport.sentMessages.filter(
        (message) => message.type === "yjs_sync_step1"
      );
      expect(syncMessages).toHaveLength(2);
      expect(manager.getConnectionState(testDocKey)).toBe("syncing");
    });
  });
});
