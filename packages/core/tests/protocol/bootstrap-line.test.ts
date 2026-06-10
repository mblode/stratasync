import {
  normalizeBootstrapMetadata,
  parseBootstrapLine,
} from "../../src/protocol/bootstrap-line.js";

describe(parseBootstrapLine, () => {
  it("parses a _metadata_= prefixed line", () => {
    const line = `_metadata_=${JSON.stringify({
      lastSyncId: "42",
      subscribedSyncGroups: ["g1"],
    })}`;
    const parsed = parseBootstrapLine(line);
    expect(parsed?.type).toBe("meta");
    if (parsed?.type === "meta") {
      expect(parsed.metadata.lastSyncId).toBe("42");
      expect(parsed.metadata.subscribedSyncGroups).toEqual(["g1"]);
    }
  });

  it("parses an embedded _metadata_ object line", () => {
    const line = JSON.stringify({ _metadata_: { lastSyncId: "7" } });
    const parsed = parseBootstrapLine(line);
    expect(parsed?.type).toBe("meta");
  });

  it("parses a __class-tagged model row and strips __class", () => {
    const line = JSON.stringify({ __class: "Task", id: "t1", title: "x" });
    const parsed = parseBootstrapLine(line);
    expect(parsed).toEqual({
      row: { data: { id: "t1", title: "x" }, modelName: "Task" },
      type: "row",
    });
  });

  it("treats a row with metadata-like fields as a row when __class is present", () => {
    const line = JSON.stringify({
      __class: "Task",
      id: "t1",
      lastSyncId: "row-field",
      subscribedSyncGroups: ["not-metadata"],
    });
    const parsed = parseBootstrapLine(line);
    expect(parsed?.type).toBe("row");
  });

  it("parses a bare metadata object via the lastSyncId heuristic", () => {
    const line = JSON.stringify({ lastSyncId: "10", subscribedSyncGroups: [] });
    const parsed = parseBootstrapLine(line);
    expect(parsed?.type).toBe("meta");
  });

  it("returns null for a blank line", () => {
    expect(parseBootstrapLine("   ")).toBeNull();
  });

  it("returns the end marker with rowCount", () => {
    expect(
      parseBootstrapLine(JSON.stringify({ rowCount: 3, type: "end" }))
    ).toEqual({
      rowCount: 3,
      type: "end",
    });
  });

  it("returns the end marker with undefined rowCount when absent", () => {
    expect(parseBootstrapLine(JSON.stringify({ type: "end" }))).toEqual({
      rowCount: undefined,
      type: "end",
    });
  });

  it("throws on a server error line", () => {
    const line = JSON.stringify({ message: "Bad token", type: "error" });
    expect(() => parseBootstrapLine(line)).toThrow(
      "Bootstrap server error: Bad token"
    );
  });

  it("throws when a non-metadata row is missing __class", () => {
    expect(() => parseBootstrapLine(JSON.stringify({ id: "t1" }))).toThrow(
      "Bootstrap row is missing __class"
    );
  });

  it("rejects a numeric lastSyncId (sync ids are strings on the wire)", () => {
    const line = `_metadata_=${JSON.stringify({ lastSyncId: 11 })}`;
    expect(() => parseBootstrapLine(line)).toThrow(
      "Bootstrap metadata lastSyncId must be a string"
    );
  });

  it("throws a friendly error on invalid JSON", () => {
    expect(() => parseBootstrapLine("{not json")).toThrow(
      /Failed to parse bootstrap line/
    );
  });
});

describe(normalizeBootstrapMetadata, () => {
  it("preserves the raw record and filters non-string sync groups", () => {
    const raw = {
      databaseVersion: 4,
      lastSyncId: "9",
      returnedModelsCount: { Task: 2 },
      schemaHash: "abc",
      subscribedSyncGroups: ["g1", 5, "g2"],
    };
    const meta = normalizeBootstrapMetadata(raw);
    expect(meta.lastSyncId).toBe("9");
    expect(meta.subscribedSyncGroups).toEqual(["g1", "g2"]);
    expect(meta.returnedModelsCount).toEqual({ Task: 2 });
    expect(meta.schemaHash).toBe("abc");
    expect(meta.databaseVersion).toBe(4);
    expect(meta.raw).toBe(raw);
  });

  it("defaults subscribedSyncGroups to an empty array", () => {
    expect(normalizeBootstrapMetadata({}).subscribedSyncGroups).toEqual([]);
  });
});
