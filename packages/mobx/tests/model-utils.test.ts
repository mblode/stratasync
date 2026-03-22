import { Model } from "@stratasync/core";

import {
  cloneModelData,
  diffModels,
  isModelDirty,
  toPlainObject,
} from "../src/model-utils";

const createTestModel = (id: string, data: Record<string, unknown>): Model => {
  const model = new Model();
  model.id = id;
  model.__data = { ...data };
  return model;
};

describe(toPlainObject, () => {
  it("returns plain object with id and all __data properties", () => {
    const model = createTestModel("test-1", {
      priority: 1,
      status: "open",
      title: "Test Task",
    });

    const plain = toPlainObject(model);

    expect(plain).toEqual({
      id: "test-1",
      priority: 1,
      status: "open",
      title: "Test Task",
    });
  });

  it("does not include _mobx or other internal properties", () => {
    const model = createTestModel("test-2", { title: "Hello" });
    model._mobx = {
      title: {
        get: () => "Hello",
        set: () => {
          // no-op for tests
        },
      },
    };

    const plain = toPlainObject(model);

    expect(plain).toEqual({ id: "test-2", title: "Hello" });
    expect(plain).not.toHaveProperty("_mobx");
    expect(plain).not.toHaveProperty("hydrated");
    expect(plain).not.toHaveProperty("store");
  });
});

describe(cloneModelData, () => {
  it("returns an independent copy that does not affect the original", () => {
    const model = createTestModel("test-3", { count: 5, title: "Original" });

    const clone = cloneModelData(model);
    clone.title = "Modified";
    clone.count = 10;

    expect(model.__data.title).toBe("Original");
    expect(model.__data.count).toBe(5);
    expect(clone.title).toBe("Modified");
    expect(clone.count).toBe(10);
  });
});

describe(diffModels, () => {
  it("detects changed fields between two models", () => {
    const a = createTestModel("test-4", { status: "open", title: "A" });
    const b = createTestModel("test-4", { status: "open", title: "B" });

    const diff = diffModels(a, b);

    expect(diff).toEqual({
      title: { new: "B", old: "A" },
    });
  });

  it("returns empty object for identical models", () => {
    const a = createTestModel("test-5", { status: "open", title: "Same" });
    const b = createTestModel("test-5", { status: "open", title: "Same" });

    const diff = diffModels(a, b);

    expect(diff).toEqual({});
  });

  it("detects fields present in one model but not the other", () => {
    const a = createTestModel("test-6", { title: "A" });
    const b = createTestModel("test-6", { description: "New", title: "A" });

    const diff = diffModels(a, b);

    expect(diff).toEqual({
      description: { new: "New", old: undefined },
    });
  });
});

describe(isModelDirty, () => {
  it("returns false for an unmodified model", () => {
    const model = createTestModel("test-7", { title: "Clean" });

    expect(isModelDirty(model)).toBeFalsy();
  });

  it("returns true after property change via markPropertyChanged", () => {
    const model = createTestModel("test-8", { title: "Before" });
    model.markPropertyChanged("title", "Before", "After");
    model.__data.title = "After";

    expect(isModelDirty(model)).toBeTruthy();
  });

  it("reads from DirtyTracker when attached", () => {
    const model = createTestModel("test-9", { title: "Clean" });
    const sym = Symbol.for("done:dirty-tracker");
    (model as Record<symbol, unknown>)[sym] = { isDirty: true };

    expect(isModelDirty(model)).toBeTruthy();
  });

  it("respects DirtyTracker returning false", () => {
    const model = createTestModel("test-10", { title: "Clean" });
    const sym = Symbol.for("done:dirty-tracker");
    (model as Record<symbol, unknown>)[sym] = { isDirty: false };

    // Even if changeSnapshot would say dirty, the tracker takes precedence
    model.markPropertyChanged("title", "Clean", "Changed");
    model.__data.title = "Changed";

    expect(isModelDirty(model)).toBeFalsy();
  });
});
