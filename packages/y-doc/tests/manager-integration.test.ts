import { YjsDocumentManager } from "../src/document-manager";
import { YjsPresenceManager } from "../src/presence-manager";
import type { DocumentKey } from "../src/types";
import { createMockTransport } from "./mock-transport";

describe("Yjs manager integration", () => {
  const testDocKey: DocumentKey = {
    entityId: "test-task-123",
    entityType: "Task",
    fieldName: "description",
  };

  it("replays presence before document sync for both transport registration orders", async () => {
    const registrationOrders = ["document-first", "presence-first"] as const;

    for (const registrationOrder of registrationOrders) {
      const transport = createMockTransport();
      const documentManager = new YjsDocumentManager({
        clientId: "test-client",
        connId: "test-conn",
      });
      const presenceManager = new YjsPresenceManager({
        clientId: "test-client",
        connId: "test-conn",
      });

      if (registrationOrder === "document-first") {
        documentManager.setTransport(transport);
        presenceManager.setTransport(transport);
      } else {
        presenceManager.setTransport(transport);
        documentManager.setTransport(transport);
      }

      presenceManager.startViewing(testDocKey);
      documentManager.connect(testDocKey);
      transport.sentMessages.length = 0;

      transport.triggerConnectionState("disconnected");
      transport.triggerConnectionState("connected");
      await Promise.resolve();

      expect(
        transport.sentMessages.map((message) =>
          message.type === "doc_view"
            ? `${message.type}:${message.state}`
            : message.type
        )
      ).toEqual(["doc_view:start", "yjs_sync_step1"]);
    }
  });
});
