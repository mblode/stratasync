import {
  DEFAULT_COMPOSITE_ID_NAMESPACE,
  createCompositeSyncId,
} from "../../src/utils/composite-ids.js";

describe(createCompositeSyncId, () => {
  it("returns a string", () => {
    const result = createCompositeSyncId("TaskLabel", ["task-1", "label-1"]);
    expectTypeOf(result).toBeString();
  });

  it("is deterministic: same inputs produce same output", () => {
    const a = createCompositeSyncId("TaskLabel", ["task-1", "label-1"]);
    const b = createCompositeSyncId("TaskLabel", ["task-1", "label-1"]);
    expect(a).toBe(b);
  });

  it("produces different IDs for different models", () => {
    const a = createCompositeSyncId("TaskLabel", ["id-1", "id-2"]);
    const b = createCompositeSyncId("ProjectLabel", ["id-1", "id-2"]);
    expect(a).not.toBe(b);
  });

  it("produces different IDs for different parts", () => {
    const a = createCompositeSyncId("TaskLabel", ["task-1", "label-1"]);
    const b = createCompositeSyncId("TaskLabel", ["task-1", "label-2"]);
    expect(a).not.toBe(b);
  });

  it("produces different IDs for different part ordering", () => {
    const a = createCompositeSyncId("TaskLabel", ["task-1", "label-1"]);
    const b = createCompositeSyncId("TaskLabel", ["label-1", "task-1"]);
    expect(a).not.toBe(b);
  });

  it("uses a custom namespace when provided", () => {
    // DNS namespace UUID
    const customNamespace = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    const withDefault = createCompositeSyncId("Model", ["a"]);
    const withCustom = createCompositeSyncId("Model", ["a"], customNamespace);
    expect(withDefault).not.toBe(withCustom);
  });

  it("returns a valid UUID v5 format", () => {
    const result = createCompositeSyncId("Task", ["id-1"]);
    // UUID v5 format: xxxxxxxx-xxxx-5xxx-yxxx-xxxxxxxxxxxx where y is 8, 9, a, or b
    const uuidRegex =
      /^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;
    expect(result).toMatch(uuidRegex);
  });

  it("exports the default namespace as a valid UUID", () => {
    const uuidRegex =
      /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
    expect(DEFAULT_COMPOSITE_ID_NAMESPACE).toMatch(uuidRegex);
  });
});
