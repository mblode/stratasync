import {
  makeObservableProperty,
  makeReferenceModelProperty,
} from "../src/index";

interface PropertyChange {
  name: string;
  oldValue: unknown;
  newValue: unknown;
}

class TestModel {
  _mobx: Record<string, { get(): unknown; set(value: unknown): void }> = {};
  __data: Record<string, unknown> = { title: "Initial" };
  declare title: string | undefined;
  changes: PropertyChange[] = [];

  propertyChanged(name: string, oldValue: unknown, newValue: unknown): void {
    this.changes.push({ name, newValue, oldValue });
  }
}

makeObservableProperty(TestModel.prototype, "title");

describe(makeObservableProperty, () => {
  it("proxies through MobX boxes and tracks changes", () => {
    const model = new TestModel();

    expect(model.title).toBe("Initial");

    model.title = "Updated";

    expect(model.__data.title).toBe("Updated");
    expect(model._mobx.title?.get()).toBe("Updated");
    expect(model.changes).toEqual([
      { name: "title", newValue: "Updated", oldValue: "Initial" },
    ]);

    model.title = "Again";

    expect(model.changes).toEqual([
      { name: "title", newValue: "Updated", oldValue: "Initial" },
      { name: "title", newValue: "Again", oldValue: "Updated" },
    ]);
  });

  it("falls back to __data when no MobX storage is present", () => {
    const model = {
      __data: { status: "open" },
      changes: [] as PropertyChange[],
      propertyChanged(name: string, oldValue: unknown, newValue: unknown) {
        this.changes.push({ name, newValue, oldValue });
      },
    } as {
      __data: Record<string, unknown>;
      status?: string;
      changes: PropertyChange[];
      propertyChanged: (
        name: string,
        oldValue: unknown,
        newValue: unknown
      ) => void;
    };

    makeObservableProperty(model, "status");

    expect(model.status).toBe("open");

    model.status = "closed";

    expect(model.__data.status).toBe("closed");
    expect((model as { _mobx?: unknown })._mobx).toBeUndefined();
    expect(model.changes).toEqual([
      { name: "status", newValue: "closed", oldValue: "open" },
    ]);
  });

  it("does not emit changes for no-op assignments", () => {
    const model = new TestModel();

    model.title = "Initial";

    expect(model.changes).toEqual([]);
    expect(model.__data.title).toBe("Initial");
  });
});

describe(makeReferenceModelProperty, () => {
  it("gets and sets reference ids via the store", () => {
    const store = {
      get: (modelName: string, id: string) => ({ id, modelName }),
    };

    const model = {
      store,
      user: null as { id?: string } | null,
      userId: "user-1" as string | null,
    };

    makeReferenceModelProperty(model, "user", "userId", "User");

    expect(model.user).toEqual({ id: "user-1", modelName: "User" });

    model.user = { id: "user-2" };

    expect(model.userId).toBe("user-2");

    model.user = null;

    expect(model.userId).toBeNull();
  });
});
