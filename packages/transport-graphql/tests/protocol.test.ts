import {
  joinSyncUrl,
  normalizeSyncEndpoint,
  parseDeltaPacket,
} from "../src/protocol";

describe("sync protocol helpers", () => {
  it("normalizes sync endpoints that include REST suffixes", () => {
    expect(
      normalizeSyncEndpoint("https://api.example.com/sync/bootstrap")
    ).toBe("https://api.example.com/sync");
    expect(normalizeSyncEndpoint("https://api.example.com/sync/batch/")).toBe(
      "https://api.example.com/sync"
    );
    expect(normalizeSyncEndpoint("https://api.example.com/sync/deltas")).toBe(
      "https://api.example.com/sync"
    );
    expect(normalizeSyncEndpoint("https://api.example.com/sync/mutate")).toBe(
      "https://api.example.com/sync"
    );
  });

  it("joins sync URLs without double slashes", () => {
    expect(joinSyncUrl("https://api.example.com/sync/", "bootstrap")).toBe(
      "https://api.example.com/sync/bootstrap"
    );
    expect(joinSyncUrl("https://api.example.com/sync", "/batch")).toBe(
      "https://api.example.com/sync/batch"
    );
  });
});

describe("delta packet parsing", () => {
  it("parses array delta packets like those in the reverse-engineering doc", () => {
    const raw = [
      {
        action: "U",
        clientId: "client-1",
        clientTxId: "tx-1",
        createdAt: "2024-07-13T06:25:40.612Z",
        data: { title: "Connect to Slack" },
        groupId: "group-a",
        groups: ["group-a"],
        id: "2361610825",
        modelId: "task-1",
        modelName: "Task",
      },
      {
        action: "G",
        data: {},
        groups: ["group-b"],
        id: "2361610826",
        modelId: "history-1",
        modelName: "TaskHistory",
      },
      {
        action: "S",
        data: {},
        id: "2361610854",
        modelId: "activity-1",
        modelName: "Activity",
      },
    ];

    const packet = parseDeltaPacket(raw);
    expect(packet).not.toBeNull();
    if (!packet) {
      return;
    }

    expect(packet.lastSyncId).toBe("2361610854");
    expect(packet.actions).toHaveLength(3);
    expect(packet.actions[0]?.action).toBe("U");
    expect(packet.actions[1]?.action).toBe("G");
    expect(packet.actions[2]?.action).toBe("S");

    const [firstAction] = packet.actions;
    expect(firstAction?.createdAt).toBeInstanceOf(Date);
    expect(firstAction?.groups).toEqual(["group-a"]);
    expect(firstAction?.groupId).toBe("group-a");
    expect(firstAction?.clientId).toBe("client-1");
    expect(firstAction?.clientTxId).toBe("tx-1");
  });

  it("rejects numeric sync IDs in transport payloads", () => {
    expect(() =>
      parseDeltaPacket([
        {
          action: "I",
          data: {},
          id: 2_361_610_825,
          modelId: "task-1",
          modelName: "Task",
        },
      ])
    ).toThrow("Sync action syncId/id must be a string");
  });

  it("ignores malformed action entries and sanitizes invalid payload fields", () => {
    const packet = parseDeltaPacket({
      actions: [
        null,
        "bad-action",
        {
          action: "I",
          createdAt: "not-a-date",
          data: ["not-an-object"],
          id: "7",
          modelId: "task-1",
          modelName: "Task",
        },
      ],
      lastSyncId: "7",
    });

    expect(packet).not.toBeNull();
    if (!packet) {
      return;
    }

    expect(packet.actions).toHaveLength(1);
    expect(packet.actions[0]).toMatchObject({
      action: "I",
      data: {},
      id: "7",
      modelId: "task-1",
      modelName: "Task",
    });
    expect(packet.actions[0]?.createdAt).toBeUndefined();
  });
});
