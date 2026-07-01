import type { Transaction } from "../../core/src/index";
import { noopReactivityAdapter } from "../../core/src/index";
import { IdentityMapRegistry } from "../src/identity-map";
import { applyPendingTransactionsToIdentityMaps } from "../src/sync/pending-hydration";

/**
 * A class-model instance with a prototype getter and _applyUpdate, mirroring
 * the shape the identity map hydrates for class-based schemas.
 */
class TaskModel {
  id!: string;
  title!: string;
  archivedAt: number | null = null;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }

  get isArchived(): boolean {
    return this.archivedAt !== null;
  }

  _applyUpdate(changes: Record<string, unknown>): void {
    Object.assign(this, changes);
  }
}

const createUnarchiveTx = (modelId: string): Transaction => ({
  action: "V",
  clientId: "client-1",
  clientTxId: `tx-${modelId}`,
  createdAt: Date.now(),
  modelId,
  modelName: "Task",
  payload: {},
  retryCount: 0,
  state: "awaitingSync",
});

describe("applyPendingTransactionsToIdentityMaps (V branch)", () => {
  it("preserves instance identity and clears archivedAt on unarchive", () => {
    const registry = new IdentityMapRegistry(
      noopReactivityAdapter,
      (_modelName, data) => new TaskModel(data)
    );
    const map = registry.getMap<Record<string, unknown>>("Task");

    const instance = map.merge("task-1", {
      archivedAt: 123,
      id: "task-1",
      title: "One",
    });
    expect(instance).toBeInstanceOf(TaskModel);

    applyPendingTransactionsToIdentityMaps(registry, [
      createUnarchiveTx("task-1"),
    ]);

    const after = map.get("task-1");
    // Same reference: the class instance (and its prototype getters) survived.
    expect(after).toBe(instance);
    expect(after).toBeInstanceOf(TaskModel);
    expect((after as TaskModel).isArchived).toBeFalsy();
    expect((after as TaskModel).archivedAt).toBeNull();
  });

  it("does not resurrect a model that is absent from the map", () => {
    const registry = new IdentityMapRegistry(
      noopReactivityAdapter,
      (_modelName, data) => new TaskModel(data)
    );
    const map = registry.getMap<Record<string, unknown>>("Task");

    applyPendingTransactionsToIdentityMaps(registry, [
      createUnarchiveTx("missing"),
    ]);

    expect(map.has("missing")).toBeFalsy();
  });
});
