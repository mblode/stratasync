import {
  parseDeltaPacket,
  parseSyncAction,
} from "../../src/protocol/delta-packet.js";

describe(parseDeltaPacket, () => {
  it("parses the {type:'delta', packet} websocket envelope", () => {
    const frame = {
      packet: {
        actions: [{ action: "I", id: "5", modelId: "t1", modelName: "Task" }],
        lastSyncId: "5",
      },
      type: "delta",
    };
    const packet = parseDeltaPacket(frame);
    expect(packet?.lastSyncId).toBe("5");
    expect(packet?.actions).toHaveLength(1);
    expect(packet?.actions[0]?.action).toBe("I");
  });

  it("parses a bare array of actions and derives lastSyncId from the max", () => {
    const packet = parseDeltaPacket([
      { action: "U", id: "3", modelId: "t1", modelName: "Task" },
      { action: "U", id: "7", modelId: "t2", modelName: "Task" },
    ]);
    expect(packet?.lastSyncId).toBe("7");
    expect(packet?.actions).toHaveLength(2);
  });

  it("parses a direct {actions, lastSyncId, hasMore} object", () => {
    const packet = parseDeltaPacket({
      actions: [{ action: "D", id: "9", modelId: "t1", modelName: "Task" }],
      hasMore: true,
      lastSyncId: "9",
    });
    expect(packet?.lastSyncId).toBe("9");
    expect(packet?.hasMore).toBeTruthy();
  });

  it("parses a single action object", () => {
    const packet = parseDeltaPacket({
      action: "I",
      id: "2",
      modelId: "t1",
      modelName: "Task",
    });
    expect(packet?.lastSyncId).toBe("2");
    expect(packet?.actions).toHaveLength(1);
  });

  it("returns null for non-packet input", () => {
    expect(parseDeltaPacket(null)).toBeNull();
    expect(parseDeltaPacket(42)).toBeNull();
    expect(parseDeltaPacket({ foo: "bar" })).toBeNull();
  });
});

describe(parseSyncAction, () => {
  it("maps wire fields including optional clientTxId/clientId/groups/createdAt", () => {
    const action = parseSyncAction({
      action: "U",
      clientId: "client-1",
      clientTxId: "tx-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      data: { title: "x" },
      groupId: "g1",
      groups: ["g1", 5, "g2"],
      modelId: "t1",
      modelName: "Task",
      syncId: "11",
    });
    expect(action.id).toBe("11");
    expect(action.clientTxId).toBe("tx-1");
    expect(action.clientId).toBe("client-1");
    expect(action.groupId).toBe("g1");
    expect(action.groups).toEqual(["g1", "g2"]);
    expect(action.data).toEqual({ title: "x" });
    expect(action.createdAt).toBeInstanceOf(Date);
  });

  it("falls back from syncId to id", () => {
    expect(
      parseSyncAction({
        action: "I",
        id: "4",
        modelId: "t1",
        modelName: "Task",
      }).id
    ).toBe("4");
  });

  it("rejects a numeric syncId (strings on the wire)", () => {
    expect(() =>
      parseSyncAction({ action: "I", id: 4, modelId: "t1", modelName: "Task" })
    ).toThrow("Sync action syncId/id must be a string");
  });

  it("throws on an unknown action code", () => {
    expect(() =>
      parseSyncAction({
        action: "X",
        id: "1",
        modelId: "t1",
        modelName: "Task",
      })
    ).toThrow("Unknown action: X");
  });
});
