/* oxlint-disable no-import-node-test -- uses Node test runner */
/* oxlint-disable max-classes-per-file */
import assert from "node:assert/strict";
import test from "node:test";

import {
  BackReference,
  ClientModel,
  computeSchemaHash,
  getOrCreateClientId,
  Model,
  ModelRegistry,
  OneToMany,
  Property,
  Reference,
  ReferenceArray,
} from "../src/index";
import { LazyCollection } from "../src/model/collection.js";
import type {
  LoadStrategy,
  ModelConstructor,
  ModelMetadata,
  PropertyMetadata,
  SchemaDefinition,
} from "../src/schema/types";
import type { SyncStore } from "../src/store/types";

interface ModelRegistryInternals {
  modelLookup: Map<string, ModelConstructor>;
  modelMetadata: Map<string, ModelMetadata>;
  modelPropertyLookup: Map<string, Map<string, PropertyMetadata>>;
  modelReferencedPropertyLookup: Map<string, Map<string, PropertyMetadata>>;
  __schemaHash: string;
  constructorLookup: WeakMap<ModelConstructor, string>;
  pendingProperties: WeakMap<ModelConstructor, Map<string, PropertyMetadata>>;
}

const resetModelRegistry = (): void => {
  const registry = ModelRegistry as unknown as ModelRegistryInternals;
  registry.modelLookup.clear();
  registry.modelMetadata.clear();
  registry.modelPropertyLookup.clear();
  registry.modelReferencedPropertyLookup.clear();
  registry.__schemaHash = "";
  registry.constructorLookup = new WeakMap();
  registry.pendingProperties = new WeakMap();
};

interface TaskHashOptions {
  loadStrategy: LoadStrategy;
  schemaVersion: number;
  indexed: boolean;
  groupKey?: string;
}

const buildTaskHash = (options: TaskHashOptions): string => {
  resetModelRegistry();

  class User extends Model {}
  class Task extends Model {}

  Reference(() => User, "assignedTasks", {
    indexed: options.indexed,
  })(Task.prototype, "assignee");
  OneToMany()(User.prototype, "assignedTasks");

  ClientModel("User")(User);
  ClientModel("Task", {
    groupKey: options.groupKey,
    loadStrategy: options.loadStrategy,
    schemaVersion: options.schemaVersion,
  })(Task);

  return ModelRegistry.getSchemaHash();
};

const buildHashWithOrder = (order: "alpha-first" | "beta-first"): string => {
  resetModelRegistry();

  class Alpha extends Model {}
  class Beta extends Model {}

  Property()(Alpha.prototype, "title");
  Property()(Beta.prototype, "name");

  if (order === "alpha-first") {
    ClientModel("Alpha")(Alpha);
    ClientModel("Beta")(Beta);
  } else {
    ClientModel("Beta")(Beta);
    ClientModel("Alpha")(Alpha);
  }

  return ModelRegistry.getSchemaHash();
};

test("registers properties before model registration and sorts property names", () => {
  resetModelRegistry();

  class Task extends Model {}

  Property()(Task.prototype, "title");
  Property()(Task.prototype, "priority");
  Property()(Task.prototype, "assignee");

  ClientModel("Task")(Task);

  const props = ModelRegistry.getModelProperties("Task");
  assert.equal(props.get("title")?.type, "property");
  assert.equal(props.get("priority")?.type, "property");
  assert.equal(props.get("assignee")?.type, "property");
  assert.deepEqual(ModelRegistry.getPropertyNames("Task"), [
    "assignee",
    "priority",
    "title",
  ]);

  const hash = ModelRegistry.getSchemaHash();
  assert.notEqual(hash, "");
  assert.equal(hash, computeSchemaHash(ModelRegistry.snapshot()));
});

test("schema hash is deterministic across registration order", () => {
  const hashAlphaFirst = buildHashWithOrder("alpha-first");
  const hashBetaFirst = buildHashWithOrder("beta-first");
  assert.equal(hashAlphaFirst, hashBetaFirst);
});

test("schema hash changes with metadata updates", () => {
  const baseHash = buildTaskHash({
    indexed: false,
    loadStrategy: "instant",
    schemaVersion: 1,
  });
  const partialHash = buildTaskHash({
    indexed: false,
    loadStrategy: "partial",
    schemaVersion: 1,
  });
  const versionHash = buildTaskHash({
    indexed: false,
    loadStrategy: "instant",
    schemaVersion: 2,
  });
  const indexedHash = buildTaskHash({
    indexed: true,
    loadStrategy: "instant",
    schemaVersion: 1,
  });
  const groupedHash = buildTaskHash({
    groupKey: "teamId",
    indexed: false,
    loadStrategy: "instant",
    schemaVersion: 1,
  });

  assert.notEqual(baseHash, partialHash);
  assert.notEqual(baseHash, versionHash);
  assert.notEqual(baseHash, indexedHash);
  assert.notEqual(baseHash, groupedHash);
});

test("schema hash handles surrogate pairs deterministically", () => {
  const schema = {
    models: {
      "Task😀": {
        fields: {
          id: {},
          title: {},
        },
        tableName: "tasks😀",
      },
    },
  };

  assert.equal(computeSchemaHash(schema), "0e96d27f35cd7d80");
});

test("schema snapshots preserve primary keys, group keys, and indexes", () => {
  const schema: SchemaDefinition = {
    models: {
      Task: {
        fields: {
          taskId: {},
          teamId: {},
          title: {},
        },
        groupKey: "teamId",
        indexes: [{ fields: ["teamId", "title"], unique: true }],
        loadStrategy: "partial",
        primaryKey: "taskId",
      },
    },
  };

  const snapshot = new ModelRegistry(schema).snapshot();
  assert.equal(snapshot.models.Task.meta.primaryKey, "taskId");
  assert.equal(snapshot.models.Task.meta.groupKey, "teamId");
  assert.deepEqual(snapshot.models.Task.meta.indexes, [
    { fields: ["teamId", "title"], unique: true },
  ]);

  const roundTripped = new ModelRegistry(snapshot).getModel("Task");
  assert.equal(roundTripped?.primaryKey, "taskId");
  assert.equal(roundTripped?.groupKey, "teamId");
  assert.deepEqual(roundTripped?.indexes, [
    { fields: ["teamId", "title"], unique: true },
  ]);
  assert.equal(Object.hasOwn(roundTripped?.fields ?? {}, "id"), false);
  assert.equal(Object.hasOwn(roundTripped?.fields ?? {}, "taskId"), true);
});

test("reference decorator registers id + model and proxies values", () => {
  resetModelRegistry();

  class User extends Model {}
  class Task extends Model {}

  Reference(() => User, "assignedTasks", {
    indexed: true,
    nullable: true,
  })(Task.prototype, "assignee");
  OneToMany()(User.prototype, "assignedTasks");

  ClientModel("User")(User);
  ClientModel("Task")(Task);

  const taskProps = ModelRegistry.getModelProperties("Task");
  const assigneeMeta = taskProps.get("assignee");
  const assigneeIdMeta = taskProps.get("assigneeId");

  assert.equal(assigneeMeta?.type, "referenceModel");
  assert.equal(assigneeIdMeta?.type, "reference");
  assert.equal(assigneeMeta?.referenceModel, "User");
  assert.equal(assigneeMeta?.foreignKey, "assigneeId");
  assert.equal(assigneeMeta?.indexed, true);
  assert.equal(assigneeMeta?.nullable, true);

  const referenced = ModelRegistry.getReferencedProperties("Task");
  assert.equal(referenced.has("assignee"), true);
  assert.equal(referenced.has("assigneeId"), false);

  const user = new User();
  user.id = "user-1";

  const storeMap = new Map<string, Model>([["User:user-1", user]]);
  const store: SyncStore = {
    get: (modelName: string, id: string) =>
      storeMap.get(`${modelName}:${id}`) ?? null,
  };

  const task = new Task();
  task.store = store;
  task.assigneeId = "user-1";
  assert.equal(task.assignee.value, user);

  task.assignee = user;
  assert.equal(task.assigneeId, "user-1");

  task.assignee = null;
  assert.equal(task.assigneeId, null);

  task.assignee = user;
  const json = task.toJSON();
  assert.equal(json.assigneeId, "user-1");
  assert.equal(Object.hasOwn(json, "assignee"), false);
});

test("reference decorator resolves registered model names for forward refs", () => {
  resetModelRegistry();

  class Task extends Model {}
  const refs: { userCtor?: ModelConstructor } = {};

  Reference(() => {
    const ctor = refs.userCtor;
    if (!ctor) {
      throw new Error("User constructor is not initialized");
    }
    return ctor;
  })(Task.prototype, "assignee");
  ClientModel("Task")(Task);

  class User extends Model {}
  refs.userCtor = User;

  Property()(User.prototype, "name");
  ClientModel("UserModel")(User);

  const taskProps = ModelRegistry.getModelProperties("Task");
  assert.equal(taskProps.get("assignee")?.referenceModel, "UserModel");
  assert.equal(taskProps.get("assigneeId")?.referenceModel, "UserModel");

  const user = new User();
  user.id = "user-1";

  const storeMap = new Map<string, Model>([["UserModel:user-1", user]]);
  const store: SyncStore = {
    get: (modelName: string, id: string) =>
      storeMap.get(`${modelName}:${id}`) ?? null,
  };

  const task = new Task();
  task.store = store;
  task.assigneeId = "user-1";

  assert.equal(task.assignee.value, user);
  assert.notEqual(ModelRegistry.getSchemaHash(), "");
});

test("cached reference promises refresh when the resolved model name changes", () => {
  resetModelRegistry();

  class Task extends Model {}
  class User extends Model {}

  Reference(() => User)(Task.prototype, "assignee");
  ClientModel("Task")(Task);

  const calls: string[] = [];
  const user = new User();
  user.id = "user-1";

  const store: SyncStore = {
    get: (modelName: string) => {
      calls.push(modelName);
      return modelName === "UserModel" ? user : null;
    },
  };

  const task = new Task();
  task.store = store;
  task.assigneeId = "user-1";

  assert.equal(task.assignee.value, undefined);

  ClientModel("UserModel")(User);

  assert.equal(task.assignee.value, user);
  assert.deepEqual(calls, ["User", "UserModel"]);
});

test("referenced properties include collections, back references, and arrays", () => {
  resetModelRegistry();

  class Task extends Model {}
  class Project extends Model {}
  class User extends Model {}

  BackReference()(Task.prototype, "favorite");
  ReferenceArray({ through: "ProjectMembership" })(
    Project.prototype,
    "members"
  );
  OneToMany()(User.prototype, "assignedTasks");

  ClientModel("Task")(Task);
  ClientModel("Project")(Project);
  ClientModel("User")(User);

  const taskProps = ModelRegistry.getModelProperties("Task");
  assert.equal(taskProps.get("favorite")?.type, "backReference");
  assert.equal(
    ModelRegistry.getReferencedProperties("Task").has("favorite"),
    true
  );

  const projectProps = ModelRegistry.getModelProperties("Project");
  assert.equal(projectProps.get("members")?.type, "referenceArray");
  assert.equal(projectProps.get("members")?.through, "ProjectMembership");
  assert.equal(
    ModelRegistry.getReferencedProperties("Project").has("members"),
    true
  );

  const userProps = ModelRegistry.getModelProperties("User");
  assert.equal(userProps.get("assignedTasks")?.type, "referenceCollection");
  assert.equal(
    ModelRegistry.getReferencedProperties("User").has("assignedTasks"),
    true
  );
});

test("observable properties track changes and serialize persisted values", () => {
  resetModelRegistry();

  const serializer = {
    deserialize: (value: unknown) =>
      Number(String(value).replace(/^ser:/u, "")),
    serialize: (value: unknown) => `ser:${String(value)}`,
  };

  interface ChangeEvent {
    name: string;
    oldValue: unknown;
    newValue: unknown;
  }

  class Task extends Model {
    lastChange: ChangeEvent | null = null;

    propertyChanged(
      propertyName: string,
      oldValue: unknown,
      newValue: unknown
    ): void {
      this.lastChange = { name: propertyName, newValue, oldValue };
      super.propertyChanged(propertyName, oldValue, newValue);
    }
  }

  Property()(Task.prototype, "title");
  Property({ serializer })(Task.prototype, "count");
  ClientModel("Task")(Task);

  const task = new Task();
  task.title = "First";

  assert.deepEqual(task.lastChange, {
    name: "title",
    newValue: "First",
    oldValue: undefined,
  });

  const titleBox = task._mobx.title;
  assert.ok(titleBox);
  assert.equal(typeof titleBox.get, "function");
  assert.equal(typeof titleBox.set, "function");

  task.title = "Second";
  assert.deepEqual(task.lastChange, {
    name: "title",
    newValue: "Second",
    oldValue: "First",
  });
  assert.equal(task.__data.title, "Second");

  task._applyUpdate({ count: "ser:2" });
  assert.equal(task.count, 2);
  assert.equal(task.__data.count, 2);
  assert.equal(task.toJSON().count, "ser:2");

  task.clearChanges();
  task.count = 3;

  const snapshot = task.changeSnapshot();
  assert.equal(snapshot.original.count, "ser:2");
  assert.equal(snapshot.changes.count, "ser:3");
});

test("no-op and reverted assignments do not emit update snapshots", () => {
  resetModelRegistry();

  class Task extends Model {}

  Property()(Task.prototype, "title");
  ClientModel("Task")(Task);

  const task = new Task();
  task.title = "First";
  task.clearChanges();

  task.title = "First";
  assert.deepEqual(task.changeSnapshot(), {
    changes: {},
    original: {},
  });

  task.title = "Second";
  task.title = "First";
  assert.deepEqual(task.changeSnapshot(), {
    changes: {},
    original: {},
  });
});

test("_applyUpdate ignores non-string ids while applying other fields", () => {
  resetModelRegistry();

  class Task extends Model {}

  Property()(Task.prototype, "title");
  ClientModel("Task")(Task);

  const task = new Task();
  task.id = "task-1";

  task._applyUpdate({ id: 123, title: "Updated title" });

  assert.equal(task.id, "task-1");
  assert.equal(task.title, "Updated title");
  assert.equal(task.__data.title, "Updated title");
  assert.equal(Object.hasOwn(task.__data, "id"), false);
});

test("save applies the row returned by store.update", async () => {
  resetModelRegistry();

  class Task extends Model {}

  Property()(Task.prototype, "title");
  Property()(Task.prototype, "updatedAt");
  ClientModel("Task")(Task);

  const task = new Task();
  task.id = "task-1";
  task.__data.title = "Before";
  task.store = {
    get: () => null,
    update: () =>
      Promise.resolve({
        title: "Server title",
        updatedAt: 123,
      }),
  };

  task.title = "Local title";
  await task.save();

  assert.equal(task.title, "Server title");
  assert.equal(task.updatedAt, 123);
  assert.deepEqual(task.changeSnapshot(), {
    changes: {},
    original: {},
  });
});

test("SyncStore uses serialized payloads for persistence operations", async () => {
  resetModelRegistry();

  const serializer = {
    deserialize: (value: unknown) =>
      Number(String(value).replace(/^ser:/u, "")),
    serialize: (value: unknown) => `ser:${String(value)}`,
  };

  class Task extends Model {}

  Property({ serializer })(Task.prototype, "count");
  ClientModel("Task")(Task);

  let createdPayload: Record<string, unknown> | undefined;
  let updatedPayload:
    | {
        changes: Record<string, unknown>;
        original: Record<string, unknown> | undefined;
      }
    | undefined;
  let deletedOriginal: Record<string, unknown> | undefined;

  const task = new Task();
  task.store = {
    create: (_modelName, data) => {
      createdPayload = data;
      return Promise.resolve({ ...data, id: "task-1" });
    },
    delete: (_modelName, _id, options) => {
      deletedOriginal = options?.original;
      return Promise.resolve();
    },
    get: () => null,
    update: (_modelName, _id, changes, options) => {
      updatedPayload = {
        changes,
        original: options?.original,
      };
      return Promise.resolve({
        count: "ser:3",
      });
    },
  };

  task.count = 2;
  await task.save();

  assert.equal(createdPayload?.count, "ser:2");
  assert.equal(task.count, 2);

  task.count = 3;
  await task.save();

  assert.equal(updatedPayload?.changes.count, "ser:3");
  assert.equal(updatedPayload?.original?.count, "ser:2");
  assert.equal(task.count, 3);

  await task.delete();
  assert.equal(deletedOriginal?.count, "ser:3");
});

test("LazyCollection preserves local additions during hydration", async () => {
  class User extends Model {}
  class Task extends Model {}

  const remoteTask = new Task();
  remoteTask.id = "task-remote";

  const localTask = new Task();
  localTask.id = "task-local";

  const pendingRows = Promise.withResolvers<Record<string, unknown>[]>();
  const user = new User();
  user.id = "user-1";
  user.store = {
    get: (_modelName: string, id: string) => {
      if (id === remoteTask.id) {
        return remoteTask;
      }
      return null;
    },
    loadByIndex: () => pendingRows.promise,
  };

  const collection = new LazyCollection<Task>();
  collection.attach(user, "assignedTasks", {
    foreignKey: "userId",
    modelName: "Task",
  });

  const hydration = collection.hydrate();
  collection.add(localTask);
  pendingRows.resolve([{ id: remoteTask.id }]);

  const items = await hydration;
  assert.deepEqual(items, [remoteTask, localTask]);
  assert.deepEqual(collection.toArray(), [remoteTask, localTask]);
});

test("LazyCollection deduplicates matching ids during hydration", async () => {
  class User extends Model {}
  class Task extends Model {}

  const remoteTask = new Task();
  remoteTask.id = "task-1";

  const localTask = new Task();
  localTask.id = "task-1";

  const pendingRows = Promise.withResolvers<Record<string, unknown>[]>();
  const user = new User();
  user.id = "user-1";
  user.store = {
    get: () => remoteTask,
    loadByIndex: () => pendingRows.promise,
  };

  const collection = new LazyCollection<Task>();
  collection.attach(user, "assignedTasks", {
    foreignKey: "userId",
    modelName: "Task",
  });

  const hydration = collection.hydrate();
  collection.add(localTask);
  pendingRows.resolve([{ id: remoteTask.id }]);

  const items = await hydration;
  assert.equal(items.length, 1);
  assert.equal(items[0], localTask);
  assert.deepEqual(collection.toArray(), [localTask]);
});

test("LazyCollection replaces matching ids on direct add", () => {
  class Task extends Model {}

  const firstTask = new Task();
  firstTask.id = "task-1";

  const replacementTask = new Task();
  replacementTask.id = "task-1";

  const collection = new LazyCollection<Task>();
  collection.add(firstTask);
  collection.add(replacementTask);

  assert.deepEqual(collection.toArray(), [replacementTask]);
});

test("LazyCollection removes matching ids across instances", () => {
  class Task extends Model {}

  const existingTask = new Task();
  existingTask.id = "task-1";

  const matchingTask = new Task();
  matchingTask.id = "task-1";

  const collection = new LazyCollection<Task>([existingTask]);

  assert.equal(collection.remove(matchingTask), true);
  assert.deepEqual(collection.toArray(), []);
});

test("LazyCollection preserves clear during hydration", async () => {
  class User extends Model {}
  class Task extends Model {}

  const remoteTask = new Task();
  remoteTask.id = "task-remote";

  const pendingRows = Promise.withResolvers<Record<string, unknown>[]>();
  const user = new User();
  user.id = "user-1";
  user.store = {
    get: () => remoteTask,
    loadByIndex: () => pendingRows.promise,
  };

  const collection = new LazyCollection<Task>();
  collection.attach(user, "assignedTasks", {
    foreignKey: "userId",
    modelName: "Task",
  });

  const hydration = collection.hydrate();
  collection.clear();
  pendingRows.resolve([{ id: remoteTask.id }]);

  const items = await hydration;
  assert.deepEqual(items, []);
  assert.deepEqual(collection.toArray(), []);
});

test("getOrCreateClientId is stable without localStorage", () => {
  const globals = globalThis as { localStorage?: unknown };
  const originalLocalStorage = globals.localStorage;
  globals.localStorage = undefined;

  try {
    const first = getOrCreateClientId("packages-core-test-client-id");
    const second = getOrCreateClientId("packages-core-test-client-id");
    assert.equal(first, second);
  } finally {
    if (originalLocalStorage === undefined) {
      Reflect.deleteProperty(globals, "localStorage");
    } else {
      globals.localStorage = originalLocalStorage;
    }
  }
});
