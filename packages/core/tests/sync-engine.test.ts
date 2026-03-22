/* oxlint-disable no-import-node-test -- uses Node test runner */
/* oxlint-disable max-classes-per-file */
import assert from "node:assert/strict";
import test from "node:test";

import {
  BackReference,
  ClientModel,
  computeSchemaHash,
  Model,
  ModelRegistry,
  OneToMany,
  Property,
  Reference,
  ReferenceArray,
} from "../src/index";
import type {
  LoadStrategy,
  ModelConstructor,
  ModelMetadata,
  PropertyMetadata,
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

  assert.notEqual(baseHash, partialHash);
  assert.notEqual(baseHash, versionHash);
  assert.notEqual(baseHash, indexedHash);
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

test("observable properties track changes and serialize originals", () => {
  resetModelRegistry();

  const serializer = {
    // oxlint-disable-next-line prefer-native-coercion-functions
    deserialize: (value: unknown) => String(value),
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

  task.clearChanges();
  task.__data.count = 2;
  task.count = 3;

  const snapshot = task.changeSnapshot();
  assert.equal(snapshot.original.count, "ser:2");
  assert.equal(snapshot.changes.count, 3);
});
