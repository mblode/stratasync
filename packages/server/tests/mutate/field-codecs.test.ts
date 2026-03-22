import type { FieldSpec } from "../../src/mutate/field-codecs.js";
import {
  buildInsertData,
  buildUpdateData,
  parseTemporalInput,
  serializeSyncData,
} from "../../src/mutate/field-codecs.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// parseTemporalInput
// ---------------------------------------------------------------------------

describe(parseTemporalInput, () => {
  it("returns null for null value", () => {
    expect(parseTemporalInput("instant", null, "field")).toBeNull();
  });

  it("returns null for undefined value", () => {
    expect(parseTemporalInput("instant", undefined, "field")).toBeNull();
  });

  it("throws for non-number input (string)", () => {
    expect(() => parseTemporalInput("instant", "hello", "field")).toThrow(
      "Invalid instant value for field"
    );
  });

  it("throws for NaN", () => {
    expect(() => parseTemporalInput("instant", Number.NaN, "field")).toThrow(
      "Invalid instant value for field"
    );
  });

  it("throws for Infinity", () => {
    expect(() =>
      parseTemporalInput("instant", Number.POSITIVE_INFINITY, "field")
    ).toThrow("Invalid instant value for field");
  });

  it("parses a valid instant epoch to a Date", () => {
    const epoch = 1_700_000_000_000;
    const result = parseTemporalInput("instant", epoch, "field");
    expect(result).toBeInstanceOf(Date);
    expect(result?.getTime()).toBe(epoch);
  });

  it("parses a valid dateOnly epoch to a Date", () => {
    // 2024-06-15
    const epoch = Date.UTC(2024, 5, 15);
    const result = parseTemporalInput("dateOnly", epoch, "field");
    expect(result).toBeInstanceOf(Date);
    expect(result?.getTime()).toBe(epoch);
  });

  it("throws for a non-day-aligned epoch in dateOnly mode", () => {
    expect(() => parseTemporalInput("dateOnly", DAY_MS + 1, "field")).toThrow(
      "Invalid dateOnly value for field"
    );
  });

  it("throws for boolean input", () => {
    expect(() =>
      parseTemporalInput("instant", true as unknown as number, "field")
    ).toThrow("Invalid instant value for field");
  });
});

// ---------------------------------------------------------------------------
// buildInsertData
// ---------------------------------------------------------------------------

describe(buildInsertData, () => {
  it("includes id when modelId is provided", () => {
    const fields: Record<string, FieldSpec> = {
      title: { type: "string" },
    };
    const result = buildInsertData("id-1", { title: "Hello" }, fields);
    expect(result.id).toBe("id-1");
    expect(result.title).toBe("Hello");
  });

  it("omits id when modelId is null", () => {
    const fields: Record<string, FieldSpec> = {
      name: { type: "string" },
    };
    const result = buildInsertData(null, { name: "Test" }, fields);
    expect(result.id).toBeUndefined();
    expect(result.name).toBe("Test");
  });

  it("coerces string fields from payload", () => {
    const fields: Record<string, FieldSpec> = {
      title: { type: "string" },
    };
    const result = buildInsertData("id", { title: "Hello" }, fields);
    expect(result.title).toBe("Hello");
  });

  it("uses default value for string field when payload value is nullish", () => {
    const fields: Record<string, FieldSpec> = {
      title: { defaultValue: "Untitled", type: "string" },
    };
    const result = buildInsertData("id", {}, fields);
    expect(result.title).toBe("Untitled");
  });

  it("coerces stringNull fields to null when missing", () => {
    const fields: Record<string, FieldSpec> = {
      description: { type: "stringNull" },
    };
    const result = buildInsertData("id", {}, fields);
    expect(result.description).toBeNull();
  });

  it("coerces number fields with default", () => {
    const fields: Record<string, FieldSpec> = {
      position: { defaultValue: 0, type: "number" },
    };
    const result = buildInsertData("id", {}, fields);
    expect(result.position).toBe(0);
  });

  it("coerces number fields from payload", () => {
    const fields: Record<string, FieldSpec> = {
      position: { type: "number" },
    };
    const result = buildInsertData("id", { position: 42 }, fields);
    expect(result.position).toBe(42);
  });

  it("coerces date fields (instant) from epoch", () => {
    const epoch = 1_700_000_000_000;
    const fields: Record<string, FieldSpec> = {
      dueAt: { type: "date" },
    };
    const result = buildInsertData("id", { dueAt: epoch }, fields);
    expect(result.dueAt).toBeInstanceOf(Date);
    expect((result.dueAt as Date).getTime()).toBe(epoch);
  });

  it("coerces dateNow to current date when payload is missing", () => {
    const fields: Record<string, FieldSpec> = {
      createdAt: { type: "dateNow" },
    };
    const before = Date.now();
    const result = buildInsertData("id", {}, fields);
    const after = Date.now();
    expect(result.createdAt).toBeInstanceOf(Date);
    const ts = (result.createdAt as Date).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("coerces dateNow from payload when provided", () => {
    const epoch = 1_700_000_000_000;
    const fields: Record<string, FieldSpec> = {
      createdAt: { type: "dateNow" },
    };
    const result = buildInsertData("id", { createdAt: epoch }, fields);
    expect(result.createdAt).toBeInstanceOf(Date);
    expect((result.createdAt as Date).getTime()).toBe(epoch);
  });

  it("coerces dateOnly fields from epoch", () => {
    const epoch = Date.UTC(2024, 5, 15);
    const fields: Record<string, FieldSpec> = {
      startDate: { type: "dateOnly" },
    };
    const result = buildInsertData("id", { startDate: epoch }, fields);
    expect(result.startDate).toBeInstanceOf(Date);
    expect((result.startDate as Date).getTime()).toBe(epoch);
  });

  it("coerces dateOnly to null when payload is missing", () => {
    const fields: Record<string, FieldSpec> = {
      startDate: { type: "dateOnly" },
    };
    const result = buildInsertData("id", {}, fields);
    expect(result.startDate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildUpdateData
// ---------------------------------------------------------------------------

describe(buildUpdateData, () => {
  it("includes only allowed fields present in payload", () => {
    const allowed = new Set(["title", "description"]);
    const specs: Record<string, FieldSpec> = {
      description: { type: "stringNull" },
      title: { type: "string" },
    };
    const result = buildUpdateData(
      { description: "Desc", secret: "x", title: "New" },
      allowed,
      specs
    );
    expect(result).toEqual({ description: "Desc", title: "New" });
  });

  it("skips fields not in allowed set", () => {
    const allowed = new Set(["title"]);
    const specs: Record<string, FieldSpec> = {
      title: { type: "string" },
    };
    const result = buildUpdateData({ other: "X", title: "Hi" }, allowed, specs);
    expect(result).toEqual({ title: "Hi" });
    expect(result.other).toBeUndefined();
  });

  it("skips undefined values in payload", () => {
    const allowed = new Set(["title"]);
    const specs: Record<string, FieldSpec> = {
      title: { type: "string" },
    };
    const result = buildUpdateData({ title: undefined }, allowed, specs);
    expect(result).toEqual({});
  });

  it("coerces date fields in update data", () => {
    const epoch = 1_700_000_000_000;
    const allowed = new Set(["dueAt"]);
    const specs: Record<string, FieldSpec> = {
      dueAt: { type: "date" },
    };
    const result = buildUpdateData({ dueAt: epoch }, allowed, specs);
    expect(result.dueAt).toBeInstanceOf(Date);
    expect((result.dueAt as Date).getTime()).toBe(epoch);
  });

  it("coerces dateOnly fields in update data", () => {
    const epoch = Date.UTC(2024, 5, 15);
    const allowed = new Set(["startDate"]);
    const specs: Record<string, FieldSpec> = {
      startDate: { type: "dateOnly" },
    };
    const result = buildUpdateData({ startDate: epoch }, allowed, specs);
    expect(result.startDate).toBeInstanceOf(Date);
    expect((result.startDate as Date).getTime()).toBe(epoch);
  });

  it("passes through non-temporal fields as-is", () => {
    const allowed = new Set(["count"]);
    const specs: Record<string, FieldSpec> = {};
    const result = buildUpdateData({ count: 5 }, allowed, specs);
    expect(result.count).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// serializeSyncData
// ---------------------------------------------------------------------------

describe(serializeSyncData, () => {
  it("serializes instant Date fields to epoch numbers", () => {
    const date = new Date("2024-06-15T12:00:00.000Z");
    const data = { createdAt: date, title: "Hi" };
    const specs: Record<string, FieldSpec> = {
      createdAt: { type: "dateNow" },
      title: { type: "string" },
    };
    const result = serializeSyncData(data, specs);
    expect(result.createdAt).toBe(date.getTime());
    expect(result.title).toBe("Hi");
  });

  it("serializes dateOnly Date fields to day-aligned epoch", () => {
    const epoch = Date.UTC(2024, 5, 15);
    const date = new Date(epoch);
    const data = { startDate: date };
    const specs: Record<string, FieldSpec> = {
      startDate: { type: "dateOnly" },
    };
    const result = serializeSyncData(data, specs);
    expect(result.startDate).toBe(epoch);
  });

  it("includes modelId when provided", () => {
    const data = { title: "Hi" };
    const specs: Record<string, FieldSpec> = { title: { type: "string" } };
    const result = serializeSyncData(data, specs, { modelId: "id-1" });
    expect(result.id).toBe("id-1");
  });

  it("does not include id when modelId is not provided", () => {
    const data = { title: "Hi" };
    const specs: Record<string, FieldSpec> = { title: { type: "string" } };
    const result = serializeSyncData(data, specs);
    expect(result.id).toBeUndefined();
  });

  it("does not include id when modelId is null", () => {
    const data = { title: "Hi" };
    const specs: Record<string, FieldSpec> = { title: { type: "string" } };
    const result = serializeSyncData(data, specs, { modelId: null });
    expect(result.id).toBeUndefined();
  });

  it("uses custom keys when provided", () => {
    const data = { description: "Desc", extra: "x", title: "Hi" };
    const specs: Record<string, FieldSpec> = {
      description: { type: "stringNull" },
      title: { type: "string" },
    };
    const result = serializeSyncData(data, specs, { keys: ["title"] });
    expect(result.title).toBe("Hi");
    expect(result.description).toBeUndefined();
    expect(result.extra).toBeUndefined();
  });

  it("passes through non-temporal values unchanged", () => {
    const data = { count: 42, name: "test" };
    const specs: Record<string, FieldSpec> = {
      count: { type: "number" },
      name: { type: "string" },
    };
    const result = serializeSyncData(data, specs);
    expect(result.count).toBe(42);
    expect(result.name).toBe("test");
  });
});
