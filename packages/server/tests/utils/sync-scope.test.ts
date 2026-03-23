import {
  dedupeSyncGroups,
  resolvePublishedDeltaGroups,
  resolveRequestedSyncGroups,
} from "../../src/utils/sync-scope.js";

// ---------------------------------------------------------------------------
// resolveRequestedSyncGroups
// ---------------------------------------------------------------------------

describe(resolveRequestedSyncGroups, () => {
  it("returns all authorized groups when requestedGroups is undefined", () => {
    const authorized = ["g1", "g2", "g3"];
    expect(resolveRequestedSyncGroups(authorized)).toEqual(["g1", "g2", "g3"]);
  });

  it("returns all authorized groups when requestedGroups is empty", () => {
    const authorized = ["g1", "g2"];
    expect(resolveRequestedSyncGroups(authorized, [])).toEqual(["g1", "g2"]);
  });

  it("filters requestedGroups to only those in authorizedGroups", () => {
    const authorized = ["g1", "g2", "g3"];
    const requested = ["g2", "g4"];
    expect(resolveRequestedSyncGroups(authorized, requested)).toEqual(["g2"]);
  });

  it("returns empty array when no requested groups are authorized", () => {
    const authorized = ["g1"];
    const requested = ["g2", "g3"];
    expect(resolveRequestedSyncGroups(authorized, requested)).toEqual([]);
  });

  it("returns a new array (not a reference to the input)", () => {
    const authorized = ["g1"];
    const result = resolveRequestedSyncGroups(authorized);
    expect(result).not.toBe(authorized);
    expect(result).toEqual(authorized);
  });
});

// ---------------------------------------------------------------------------
// resolvePublishedDeltaGroups
// ---------------------------------------------------------------------------

describe(resolvePublishedDeltaGroups, () => {
  it("returns [groupId] when groupId is a non-empty string", () => {
    expect(resolvePublishedDeltaGroups("g1", ["g2", "g3"])).toEqual(["g1"]);
  });

  it("returns an empty group list when groupId is null", () => {
    expect(resolvePublishedDeltaGroups(null, ["g2", "g3"])).toEqual([]);
  });

  it("returns an empty group list when groupId is undefined", () => {
    expect(resolvePublishedDeltaGroups(undefined, ["g2"])).toEqual([]);
  });

  it("returns an empty group list when groupId is empty string", () => {
    expect(resolvePublishedDeltaGroups("", ["g2"])).toEqual([]);
  });

  it("returns a new empty array", () => {
    const fallback = ["g1"];
    const result = resolvePublishedDeltaGroups(null, fallback);
    expect(result).not.toBe(fallback);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// dedupeSyncGroups
// ---------------------------------------------------------------------------

describe(dedupeSyncGroups, () => {
  it("removes duplicate groups", () => {
    expect(dedupeSyncGroups(["g1", "g2", "g1", "g3", "g2"])).toEqual([
      "g1",
      "g2",
      "g3",
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(dedupeSyncGroups([])).toEqual([]);
  });

  it("preserves order of first occurrence", () => {
    expect(dedupeSyncGroups(["b", "a", "b", "c", "a"])).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("returns the same values if no duplicates", () => {
    expect(dedupeSyncGroups(["x", "y", "z"])).toEqual(["x", "y", "z"]);
  });
});
