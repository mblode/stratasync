import type { SyncActionOutput } from "../../src/types.js";
import {
  parseSyncActionOutput,
  parseSyncIdString,
  serializeSyncActionOutput,
  serializeSyncId,
  toSyncActionOutput,
} from "../../src/utils/sync-utils.js";

// ---------------------------------------------------------------------------
// serializeSyncId
// ---------------------------------------------------------------------------

describe(serializeSyncId, () => {
  it("converts 0n to '0'", () => {
    expect(serializeSyncId(0n)).toBe("0");
  });

  it("converts a small bigint", () => {
    expect(serializeSyncId(42n)).toBe("42");
  });

  it("converts a large bigint", () => {
    // exceeds Number.MAX_SAFE_INTEGER
    const big = 9_007_199_254_740_993n;
    expect(serializeSyncId(big)).toBe("9007199254740993");
  });
});

// ---------------------------------------------------------------------------
// parseSyncIdString
// ---------------------------------------------------------------------------

describe(parseSyncIdString, () => {
  it("parses '0' to 0n", () => {
    expect(parseSyncIdString("0")).toBe(0n);
  });

  it("parses a numeric string to bigint", () => {
    expect(parseSyncIdString("12345")).toBe(12_345n);
  });

  it("throws for a negative number string", () => {
    expect(() => parseSyncIdString("-1")).toThrow("Invalid syncId");
  });

  it("throws for a floating-point string", () => {
    expect(() => parseSyncIdString("1.5")).toThrow("Invalid syncId");
  });

  it("throws for an empty string", () => {
    expect(() => parseSyncIdString("")).toThrow("Invalid syncId");
  });

  it("throws for a non-numeric string", () => {
    expect(() => parseSyncIdString("abc")).toThrow("Invalid syncId");
  });

  it("round-trips with serializeSyncId", () => {
    const original = 999_999n;
    expect(parseSyncIdString(serializeSyncId(original))).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// toSyncActionOutput
// ---------------------------------------------------------------------------

describe(toSyncActionOutput, () => {
  it("maps a raw DB row to SyncActionOutput", () => {
    const createdAt = new Date("2024-06-15T12:00:00Z");
    const raw = {
      action: "I",
      clientId: "client-1",
      clientTxId: "tx-1",
      createdAt,
      data: { title: "Hello" },
      groupId: "workspace-1",
      id: 100n,
      model: "Task",
      modelId: "task-1",
    };

    const result = toSyncActionOutput(raw);

    expect(result.syncId).toBe("100");
    expect(result.modelName).toBe("Task");
    expect(result.modelId).toBe("task-1");
    expect(result.action).toBe("I");
    expect(result.data).toEqual({ title: "Hello" });
    expect(result.groupId).toBe("workspace-1");
    expect(result.clientTxId).toBe("tx-1");
    expect(result.clientId).toBe("client-1");
    expect(result.createdAt).toBe(createdAt);
  });

  it("converts null optional fields to undefined", () => {
    const raw = {
      action: "U",
      clientId: null,
      clientTxId: null,
      createdAt: new Date(),
      data: {},
      groupId: null,
      id: 1n,
      model: "Task",
      modelId: "task-1",
    };

    const result = toSyncActionOutput(raw);

    expect(result.groupId).toBeUndefined();
    expect(result.clientTxId).toBeUndefined();
    expect(result.clientId).toBeUndefined();
  });

  it("defaults null data to empty object", () => {
    const raw = {
      action: "D",
      clientId: null,
      clientTxId: null,
      createdAt: new Date(),
      data: null,
      groupId: null,
      id: 1n,
      model: "Task",
      modelId: "task-1",
    };

    const result = toSyncActionOutput(raw);
    expect(result.data).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// serializeSyncActionOutput
// ---------------------------------------------------------------------------

describe(serializeSyncActionOutput, () => {
  it("serializes createdAt to ISO string", () => {
    const action: SyncActionOutput = {
      action: "I",
      clientId: "c1",
      clientTxId: "tx-1",
      createdAt: new Date("2024-06-15T12:00:00.000Z"),
      data: { title: "Hello" },
      groupId: "g1",
      modelId: "task-1",
      modelName: "Task",
      syncId: "100",
    };

    const result = serializeSyncActionOutput(action);

    expect(result.createdAt).toBe("2024-06-15T12:00:00.000Z");
    expect(result.syncId).toBe("100");
    expect(result.modelName).toBe("Task");
    expect(result.data).toEqual({ title: "Hello" });
  });
});

// ---------------------------------------------------------------------------
// parseSyncActionOutput
// ---------------------------------------------------------------------------

describe(parseSyncActionOutput, () => {
  const validRaw = {
    action: "I",
    clientId: "c1",
    clientTxId: "tx-1",
    createdAt: "2024-06-15T12:00:00.000Z",
    data: { title: "Hello" },
    groupId: "g1",
    modelId: "task-1",
    modelName: "Task",
    syncId: "100",
  };

  it("parses a valid raw object", () => {
    const result = parseSyncActionOutput(validRaw);

    expect(result.syncId).toBe("100");
    expect(result.modelName).toBe("Task");
    expect(result.modelId).toBe("task-1");
    expect(result.action).toBe("I");
    expect(result.data).toEqual({ title: "Hello" });
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.createdAt.toISOString()).toBe("2024-06-15T12:00:00.000Z");
    expect(result.groupId).toBe("g1");
    expect(result.clientTxId).toBe("tx-1");
    expect(result.clientId).toBe("c1");
  });

  it("throws for non-object input", () => {
    expect(() => parseSyncActionOutput("string")).toThrow(
      "Sync action must be an object"
    );
    expect(() => parseSyncActionOutput(null)).toThrow(
      "Sync action must be an object"
    );
  });

  it("throws for missing action", () => {
    const { action: _, ...rest } = validRaw;
    expect(() => parseSyncActionOutput(rest)).toThrow(
      "Sync action action must be a string"
    );
  });

  it("throws for missing createdAt", () => {
    const { createdAt: _, ...rest } = validRaw;
    expect(() => parseSyncActionOutput(rest)).toThrow(
      "Sync action createdAt must be a string"
    );
  });

  it("throws for invalid createdAt date", () => {
    expect(() =>
      parseSyncActionOutput({ ...validRaw, createdAt: "not-a-date" })
    ).toThrow("Sync action createdAt must be a valid date");
  });

  it("throws for missing data", () => {
    const { data: _, ...rest } = validRaw;
    expect(() => parseSyncActionOutput(rest)).toThrow(
      "Sync action data must be an object"
    );
  });

  it("throws for missing modelId", () => {
    const { modelId: _, ...rest } = validRaw;
    expect(() => parseSyncActionOutput(rest)).toThrow(
      "Sync action modelId must be a string"
    );
  });

  it("throws for missing modelName", () => {
    const { modelName: _, ...rest } = validRaw;
    expect(() => parseSyncActionOutput(rest)).toThrow(
      "Sync action modelName must be a string"
    );
  });

  it("throws for missing syncId", () => {
    const { syncId: _, ...rest } = validRaw;
    expect(() => parseSyncActionOutput(rest)).toThrow(
      "Sync action syncId must be a string"
    );
  });

  it("throws for non-numeric syncId", () => {
    expect(() => parseSyncActionOutput({ ...validRaw, syncId: "abc" })).toThrow(
      "Invalid syncId"
    );
  });

  it("omits optional fields when not present", () => {
    const { groupId: _, clientTxId: _2, clientId: _3, ...rest } = validRaw;
    const result = parseSyncActionOutput(rest);
    expect(result.groupId).toBeUndefined();
    expect(result.clientTxId).toBeUndefined();
    expect(result.clientId).toBeUndefined();
  });

  // -- Round-trip --

  it("round-trips through serialize then parse", () => {
    const action: SyncActionOutput = {
      action: "U",
      createdAt: new Date("2024-06-15T12:00:00.000Z"),
      data: { title: "Updated" },
      groupId: "g1",
      modelId: "task-1",
      modelName: "Task",
      syncId: "42",
    };

    const serialized = serializeSyncActionOutput(action);
    const parsed = parseSyncActionOutput(serialized);

    expect(parsed.syncId).toBe(action.syncId);
    expect(parsed.modelName).toBe(action.modelName);
    expect(parsed.modelId).toBe(action.modelId);
    expect(parsed.action).toBe(action.action);
    expect(parsed.data).toEqual(action.data);
    expect(parsed.createdAt.getTime()).toBe(action.createdAt.getTime());
    expect(parsed.groupId).toBe(action.groupId);
  });
});
