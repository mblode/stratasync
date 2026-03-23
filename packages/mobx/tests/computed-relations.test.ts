/* oxlint-disable max-classes-per-file */
import { Model } from "@stratasync/core";
import { reaction } from "mobx";

import {
  computedCollection,
  computedReference,
} from "../src/computed-relations";
import { makeObservableProperty } from "../src/index";

class TaskModel extends Model {
  declare teamId: string | null;
}

class CommentModel extends Model {
  declare taskId: string | null;
}

makeObservableProperty(TaskModel.prototype, "teamId");
makeObservableProperty(CommentModel.prototype, "taskId");

const createTestModel = function createTestModel<T extends Model>(
  ctor: new () => T,
  id: string,
  data: Record<string, unknown>
): T {
  const model = new ctor();
  model.id = id;
  model._applyUpdate(data);
  return model;
};

describe(computedReference, () => {
  it("resolves a related model from store", () => {
    const teamModel = createTestModel(Model, "team-1", { name: "Engineering" });
    const store = {
      get: () => Promise.resolve(null),
      getCached: (modelName: string, id: string) => {
        if (modelName === "Team" && id === "team-1") {
          return teamModel;
        }
        return null;
      },
    };

    const task = createTestModel(TaskModel, "task-1", { teamId: "team-1" });
    task.store = store;

    const ref = computedReference<Model>(task, "teamId", "Team");

    expect(ref.get()).toBe(teamModel);
  });

  it("returns null when foreign key is null", () => {
    const store = {
      get: () => Promise.resolve(null),
      getCached: () => null,
    };

    const task = createTestModel(TaskModel, "task-2", { teamId: null });
    task.store = store;

    const ref = computedReference<Model>(task, "teamId", "Team");

    expect(ref.get()).toBeNull();
  });

  it("returns null when store is not set", () => {
    const task = createTestModel(TaskModel, "task-3", { teamId: "team-1" });

    const ref = computedReference<Model>(task, "teamId", "Team");

    expect(ref.get()).toBeNull();
  });

  it("does not return promises when the store only supports async get", () => {
    const task = createTestModel(TaskModel, "task-4", { teamId: "team-1" });
    task.store = {
      get: () => Promise.resolve({ id: "team-1" }),
    };

    const ref = computedReference<Record<string, unknown>>(
      task,
      "teamId",
      "Team"
    );

    expect(ref.get()).toBeNull();
  });

  it("updates when the foreign key changes in a reaction", () => {
    const teamA = createTestModel(Model, "team-a", { name: "Team A" });
    const teamB = createTestModel(Model, "team-b", { name: "Team B" });
    const store = {
      get: () => Promise.resolve(null),
      getCached: (_modelName: string, id: string) => {
        if (id === "team-a") {
          return teamA;
        }
        if (id === "team-b") {
          return teamB;
        }
        return null;
      },
    };

    const task = createTestModel(TaskModel, "task-5", { teamId: "team-a" });
    task.store = store;

    const ref = computedReference<Model>(task, "teamId", "Team");

    const values: (Model | null)[] = [];
    const dispose = reaction(
      () => ref.get(),
      (value) => values.push(value),
      { fireImmediately: true }
    );

    task.teamId = "team-b";

    expect(values).toEqual([teamA, teamB]);

    dispose();
  });
});

describe(computedCollection, () => {
  it("returns matching models", () => {
    const comment1 = createTestModel(CommentModel, "c1", {
      taskId: "task-1",
      text: "A",
    });
    const comment2 = createTestModel(CommentModel, "c2", {
      taskId: "task-1",
      text: "B",
    });
    const comment3 = createTestModel(CommentModel, "c3", {
      taskId: "task-2",
      text: "C",
    });

    const store = {
      get: () => Promise.resolve(null),
      getAll: (modelName: string) => {
        if (modelName === "Comment") {
          return [comment1, comment2, comment3];
        }
        return [];
      },
    };

    const task = createTestModel(TaskModel, "task-1", { title: "Test" });
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
      get: () => Promise.resolve(null),
      getAll: () => [],
    };

    const task = createTestModel(TaskModel, "task-3", { title: "Test" });
    task.store = store;

    const comments = computedCollection<Model>(task, "Comment", "taskId");

    expect(comments.get()).toEqual([]);
  });

  it("returns empty array when store has no getAll", () => {
    const store = {
      get: () => Promise.resolve(null),
    };

    const task = createTestModel(TaskModel, "task-4", { title: "Test" });
    task.store = store;

    const comments = computedCollection<Model>(task, "Comment", "taskId");

    expect(comments.get()).toEqual([]);
  });

  it("returns empty array when store getAll is async", () => {
    const task = createTestModel(TaskModel, "task-async", { title: "Test" });
    task.store = {
      get: () => Promise.resolve(null),
      getAll: () => Promise.resolve([]),
    };

    const comments = computedCollection<Model>(task, "Comment", "taskId");

    expect(comments.get()).toEqual([]);
  });

  it("returns empty array when store is not set", () => {
    const task = createTestModel(TaskModel, "task-5", { title: "Test" });

    const comments = computedCollection<Model>(task, "Comment", "taskId");

    expect(comments.get()).toEqual([]);
  });

  it("updates when a related model moves into the collection", () => {
    const comment = createTestModel(CommentModel, "c1", { taskId: "other" });
    const store = {
      get: () => Promise.resolve(null),
      getAll: () => [comment],
    };

    const task = createTestModel(TaskModel, "task-6", { title: "Test" });
    task.store = store;
    comment.store = store;

    const comments = computedCollection<CommentModel>(
      task,
      "Comment",
      "taskId"
    );
    const values: string[][] = [];
    const dispose = reaction(
      () => comments.get().map((current) => current.id),
      (value) => values.push(value),
      { fireImmediately: true }
    );

    comment.taskId = "task-6";

    expect(values).toEqual([[], ["c1"]]);
    dispose();
  });
});
