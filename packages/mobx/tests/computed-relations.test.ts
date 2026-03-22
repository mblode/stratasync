import { Model } from "@stratasync/core";
import { reaction } from "mobx";

import {
  computedCollection,
  computedReference,
} from "../src/computed-relations";

const createTestModel = (id: string, data: Record<string, unknown>): Model => {
  const model = new Model();
  model.id = id;
  model.__data = { ...data };
  return model;
};

describe(computedReference, () => {
  it("resolves a related model from store", () => {
    const teamModel = createTestModel("team-1", { name: "Engineering" });
    const store = {
      get: (modelName: string, id: string) => {
        if (modelName === "Team" && id === "team-1") {
          return teamModel;
        }
      },
    };

    const task = createTestModel("task-1", { teamId: "team-1" });
    task.store = store;

    const ref = computedReference<Model>(task, "teamId", "Team");

    expect(ref.get()).toBe(teamModel);
  });

  it("returns null when foreign key is null", () => {
    const store = {
      get: () => {
        /* noop */
      },
    };

    const task = createTestModel("task-2", { teamId: null });
    task.store = store;

    const ref = computedReference<Model>(task, "teamId", "Team");

    expect(ref.get()).toBeNull();
  });

  it("returns null when store is not set", () => {
    const task = createTestModel("task-3", { teamId: "team-1" });

    const ref = computedReference<Model>(task, "teamId", "Team");

    expect(ref.get()).toBeNull();
  });

  it("updates when the foreign key changes in a reaction", () => {
    const teamA = createTestModel("team-a", { name: "Team A" });
    const teamB = createTestModel("team-b", { name: "Team B" });
    const store = {
      get: (_modelName: string, id: string) => {
        if (id === "team-a") {
          return teamA;
        }
        if (id === "team-b") {
          return teamB;
        }
      },
    };

    const task = createTestModel("task-4", { teamId: "team-a" });
    task.store = store;

    const ref = computedReference<Model>(task, "teamId", "Team");

    const values: (Model | null)[] = [];
    const dispose = reaction(
      () => ref.get(),
      (value) => values.push(value),
      { fireImmediately: true }
    );

    // The first value is team-a
    expect(values[0]).toBe(teamA);

    dispose();
  });
});

describe(computedCollection, () => {
  it("returns matching models", () => {
    const comment1 = createTestModel("c1", { taskId: "task-1", text: "A" });
    const comment2 = createTestModel("c2", { taskId: "task-1", text: "B" });
    const comment3 = createTestModel("c3", { taskId: "task-2", text: "C" });

    const store = {
      get: () => {
        /* noop */
      },
      getAll: (modelName: string) => {
        if (modelName === "Comment") {
          return [comment1, comment2, comment3];
        }
        return [];
      },
    };

    const task = createTestModel("task-1", { title: "Test" });
    task.store = store;

    const comments = computedCollection<Model>(task, "Comment", "taskId");
    const result = comments.get();

    expect(result).toHaveLength(2);
    expect(result).toContain(comment1);
    expect(result).toContain(comment2);
    expect(result).not.toContain(comment3);
  });

  it("returns empty array when no matches", () => {
    const store = {
      get: () => {
        /* noop */
      },
      getAll: () => [],
    };

    const task = createTestModel("task-3", { title: "Test" });
    task.store = store;

    const comments = computedCollection<Model>(task, "Comment", "taskId");

    expect(comments.get()).toEqual([]);
  });

  it("returns empty array when store has no getAll", () => {
    const store = {
      get: () => {
        /* noop */
      },
    };

    const task = createTestModel("task-4", { title: "Test" });
    task.store = store;

    const comments = computedCollection<Model>(task, "Comment", "taskId");

    expect(comments.get()).toEqual([]);
  });

  it("returns empty array when store is not set", () => {
    const task = createTestModel("task-5", { title: "Test" });

    const comments = computedCollection<Model>(task, "Comment", "taskId");

    expect(comments.get()).toEqual([]);
  });
});
