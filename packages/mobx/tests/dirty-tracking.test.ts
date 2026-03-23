import { autorun, reaction } from "mobx";

import {
  DIRTY_TRACKER,
  createDirtyTracker,
  getDirtyTracker,
} from "../src/dirty-tracking";
import { Model, makeObservableProperty } from "../src/index";

class TestTask extends Model {
  declare title: string;
  declare status: string;
}

makeObservableProperty(TestTask.prototype, "title");
makeObservableProperty(TestTask.prototype, "status");

const createTestTask = function createTestTask(
  data?: Record<string, unknown>
): TestTask {
  const task = new TestTask();
  task.__data = { status: "open", title: "Initial", ...data };
  task._mobx = {};
  task.id = "task-1";
  return task;
};

describe(createDirtyTracker, () => {
  it("model starts not dirty after tracker is created", () => {
    const task = createTestTask();
    const tracker = createDirtyTracker(task);

    expect(tracker.isDirty).toBeFalsy();
    expect(tracker.modifiedCount).toBe(0);
    expect(tracker.modifiedFields.size).toBe(0);
  });

  it("setting a property via the model marks it dirty", () => {
    const task = createTestTask();
    const tracker = createDirtyTracker(task);

    task.title = "Updated";

    expect(tracker.isDirty).toBeTruthy();
    expect(tracker.modifiedCount).toBe(1);
  });

  it("tracks models that were already dirty before the tracker was attached", () => {
    const task = createTestTask();

    task.title = "Updated";

    const tracker = createDirtyTracker(task);

    expect(tracker.isDirty).toBeTruthy();
    expect([...tracker.modifiedFields]).toEqual(["title"]);
  });

  it("modifiedFields contains only the changed property names", () => {
    const task = createTestTask();
    const tracker = createDirtyTracker(task);

    task.title = "Updated";

    expect(tracker.modifiedFields.has("title")).toBeTruthy();
    expect(tracker.modifiedFields.has("status")).toBeFalsy();
    expect(tracker.modifiedFields.size).toBe(1);

    task.status = "closed";

    expect(tracker.modifiedFields.has("title")).toBeTruthy();
    expect(tracker.modifiedFields.has("status")).toBeTruthy();
    expect(tracker.modifiedFields.size).toBe(2);
  });

  it("_applyUpdate does NOT mark model dirty", () => {
    const task = createTestTask();
    const tracker = createDirtyTracker(task);

    task._applyUpdate({ status: "done", title: "Server Update" });

    expect(tracker.isDirty).toBeFalsy();
    expect(tracker.modifiedCount).toBe(0);
    expect(tracker.modifiedFields.size).toBe(0);
    // Verify the values actually changed
    expect(task.__data.title).toBe("Server Update");
    expect(task.__data.status).toBe("done");
  });

  it("clearChanges resets isDirty to false", () => {
    const task = createTestTask();
    const tracker = createDirtyTracker(task);

    task.title = "Changed";
    expect(tracker.isDirty).toBeTruthy();

    tracker.clear();

    expect(tracker.isDirty).toBeFalsy();
    expect(tracker.modifiedCount).toBe(0);
    expect(tracker.modifiedFields.size).toBe(0);
  });

  it("ignores no-op assignments", () => {
    const task = createTestTask();
    const tracker = createDirtyTracker(task);

    task.title = "Initial";

    expect(tracker.isDirty).toBeFalsy();
    expect(task.changeSnapshot()).toEqual({ changes: {}, original: {} });
  });

  it("clears dirty state when a field is reverted to its original value", () => {
    const task = createTestTask();
    const tracker = createDirtyTracker(task);

    task.title = "Updated";
    task.title = "Initial";

    expect(tracker.isDirty).toBeFalsy();
    expect(tracker.modifiedFields.size).toBe(0);
    expect(task.changeSnapshot()).toEqual({ changes: {}, original: {} });
  });

  it("dirty state is observable (MobX reactions fire when isDirty changes)", () => {
    const task = createTestTask();
    const tracker = createDirtyTracker(task);
    const observed: boolean[] = [];

    const dispose = reaction(
      () => tracker.isDirty,
      (dirty) => observed.push(dirty)
    );

    task.title = "Changed";
    expect(observed).toEqual([true]);

    tracker.clear();
    expect(observed).toEqual([true, false]);

    dispose();
  });

  it("creating tracker is idempotent (calling twice returns same tracker)", () => {
    const task = createTestTask();
    const tracker1 = createDirtyTracker(task);
    const tracker2 = createDirtyTracker(task);

    expect(tracker1).toBe(tracker2);
  });

  it("getDirtyTracker returns undefined for models without a tracker", () => {
    const task = createTestTask();
    expect(getDirtyTracker(task)).toBeUndefined();
  });

  it("getDirtyTracker returns the tracker after creation", () => {
    const task = createTestTask();
    const tracker = createDirtyTracker(task);
    expect(getDirtyTracker(task)).toBe(tracker);
  });

  it("dispose restores the original model methods and detaches the tracker", () => {
    const task = createTestTask();
    const originalMarkPropertyChanged = task.markPropertyChanged;
    const originalClearChanges = task.clearChanges;
    const tracker = createDirtyTracker(task);

    tracker.dispose();

    expect(task.markPropertyChanged).toBe(originalMarkPropertyChanged);
    expect(task.clearChanges).toBe(originalClearChanges);
    expect((task as Record<symbol, unknown>)[DIRTY_TRACKER]).toBeUndefined();
    expect(getDirtyTracker(task)).toBeUndefined();
  });

  it("stops tracking future changes after dispose", () => {
    const task = createTestTask();
    const tracker = createDirtyTracker(task);

    tracker.dispose();
    task.title = "Updated";

    expect(tracker.isDirty).toBeFalsy();
    expect(tracker.modifiedFields.size).toBe(0);
    expect(getDirtyTracker(task)).toBeUndefined();
  });

  it("modifiedCount is observable", () => {
    const task = createTestTask();
    const tracker = createDirtyTracker(task);
    const counts: number[] = [];

    const dispose = autorun(() => {
      counts.push(tracker.modifiedCount);
    });

    task.title = "A";
    task.status = "B";

    expect(counts).toEqual([0, 1, 2]);

    dispose();
  });
});
