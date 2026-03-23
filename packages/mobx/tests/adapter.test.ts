import { reaction } from "mobx";

import {
  Model,
  createMobXReactivity,
  makeObservableProperty,
  mobxReactivityAdapter,
} from "../src/index";

class AdapterTestModel extends Model {
  declare title: string;
}

makeObservableProperty(AdapterTestModel.prototype, "title");

const createAdapterTestModel = function createAdapterTestModel(
  title = "Start"
): AdapterTestModel {
  const model = new AdapterTestModel();
  model._applyUpdate({ title });
  return model;
};

describe("mobx reactivity adapter", () => {
  it("returns the shared adapter instance", () => {
    expect(createMobXReactivity()).toBe(mobxReactivityAdapter);
  });

  it("initializes model property observability for the singleton export", () => {
    const model = createAdapterTestModel();
    const values: string[] = [];

    const dispose = reaction(
      () => model.title,
      (value) => values.push(value),
      { fireImmediately: true }
    );

    model.title = "Next";

    expect(values).toEqual(["Start", "Next"]);
    dispose();
  });

  it("creates observable boxes that notify reactions", () => {
    const adapter = createMobXReactivity();
    const box = adapter.createBox(1);
    const values: number[] = [];

    const dispose = adapter.reaction(
      () => box.get(),
      (value) => values.push(value),
      { fireImmediately: true }
    );

    box.set(2);
    box.set(3);

    expect(values).toEqual([1, 2, 3]);
    dispose();
  });

  it("batches updates with action", () => {
    const adapter = createMobXReactivity();
    const box = adapter.createBox(0);
    const values: number[] = [];

    const dispose = adapter.reaction(
      () => box.get(),
      (value) => values.push(value)
    );

    adapter.batch(() => {
      box.set(1);
      box.set(2);
    });

    expect(values).toEqual([2]);
    dispose();
  });

  it("creates observable maps that react to key changes", () => {
    const adapter = createMobXReactivity();
    const map = adapter.createMap([["a", 1]]);
    const values: (number | undefined)[] = [];

    const dispose = adapter.reaction(
      () => map.get("a"),
      (value) => values.push(value),
      { fireImmediately: true }
    );

    map.set("a", 2);

    expect(values).toEqual([1, 2]);
    dispose();
  });

  it("creates observable arrays that track length changes", () => {
    const adapter = createMobXReactivity();
    const array = adapter.createArray([1, 2, 3]);
    const lengths: number[] = [];

    const dispose = adapter.reaction(
      () => array.length,
      (value) => lengths.push(value),
      { fireImmediately: true }
    );

    array.push(4);
    array.remove((value) => value % 2 === 0);

    expect(array.toArray()).toEqual([1, 3]);
    expect(lengths).toEqual([3, 4, 2]);
    dispose();
  });

  it("supports computed values derived from observables", () => {
    const adapter = createMobXReactivity();
    const box = adapter.createBox(2);
    const doubled = adapter.computed(() => box.get() * 2);
    const values: number[] = [];

    const dispose = adapter.reaction(
      () => doubled.get(),
      (value) => values.push(value),
      { fireImmediately: true }
    );

    box.set(3);

    expect(values).toEqual([4, 6]);
    dispose();
  });

  it("makes objects observable", () => {
    const adapter = createMobXReactivity();
    const target = { count: 0 };
    const observableTarget = adapter.makeObservable(target);
    const values: number[] = [];

    const dispose = adapter.reaction(
      () => observableTarget.count,
      (value) => values.push(value),
      { fireImmediately: true }
    );

    adapter.runInAction(() => {
      observableTarget.count = 1;
    });

    expect(values).toEqual([0, 1]);
    dispose();
  });

  it("respects the deep option when making objects observable", () => {
    const adapter = createMobXReactivity();
    const target = adapter.makeObservable(
      { nested: { count: 0 } },
      { deep: false }
    );
    const values: number[] = [];

    const dispose = reaction(
      () => target.nested.count,
      (value) => values.push(value),
      { fireImmediately: true }
    );

    target.nested.count = 1;

    expect(values).toEqual([0]);
    dispose();
  });

  describe("map", () => {
    it("has() returns true for existing keys", () => {
      const adapter = createMobXReactivity();
      const map = adapter.createMap<string, number>([["a", 1]]);

      expect(map.has("a")).toBeTruthy();
      expect(map.has("b")).toBeFalsy();
    });

    it("delete() removes a key and returns true", () => {
      const adapter = createMobXReactivity();
      const map = adapter.createMap<string, number>([
        ["a", 1],
        ["b", 2],
      ]);

      const result = map.delete("a");

      expect(result).toBeTruthy();
      expect(map.has("a")).toBeFalsy();
      expect(map.size).toBe(1);
    });

    it("delete() returns false for non-existent key", () => {
      const adapter = createMobXReactivity();
      const map = adapter.createMap<string, number>([["a", 1]]);

      const result = map.delete("z");

      expect(result).toBeFalsy();
      expect(map.size).toBe(1);
    });

    it("clear() removes all entries", () => {
      const adapter = createMobXReactivity();
      const map = adapter.createMap<string, number>([
        ["a", 1],
        ["b", 2],
        ["c", 3],
      ]);

      map.clear();

      expect(map.size).toBe(0);
      expect(map.has("a")).toBeFalsy();
    });

    it("size reflects the number of entries", () => {
      const adapter = createMobXReactivity();
      const map = adapter.createMap<string, number>();

      expect(map.size).toBe(0);

      map.set("a", 1);
      expect(map.size).toBe(1);

      map.set("b", 2);
      expect(map.size).toBe(2);

      map.delete("a");
      expect(map.size).toBe(1);
    });

    it("keys() iterates over keys", () => {
      const adapter = createMobXReactivity();
      const map = adapter.createMap<string, number>([
        ["a", 1],
        ["b", 2],
        ["c", 3],
      ]);

      const keys = [...map.keys()];

      expect(keys).toEqual(["a", "b", "c"]);
    });

    it("values() iterates over values", () => {
      const adapter = createMobXReactivity();
      const map = adapter.createMap<string, number>([
        ["a", 1],
        ["b", 2],
        ["c", 3],
      ]);

      const values = [...map.values()];

      expect(values).toEqual([1, 2, 3]);
    });

    it("entries() iterates over key-value pairs", () => {
      const adapter = createMobXReactivity();
      const map = adapter.createMap<string, number>([
        ["a", 1],
        ["b", 2],
      ]);

      const entries = [...map.entries()];

      expect(entries).toEqual([
        ["a", 1],
        ["b", 2],
      ]);
    });

    it("forEach() calls callback for each entry", () => {
      const adapter = createMobXReactivity();
      const map = adapter.createMap<string, number>([
        ["x", 10],
        ["y", 20],
      ]);
      const collected: [string, number][] = [];

      // oxlint-disable-next-line no-array-for-each
      map.forEach((value, key) => {
        collected.push([key, value]);
      });

      expect(collected).toEqual([
        ["x", 10],
        ["y", 20],
      ]);
    });
  });

  describe("array", () => {
    it("filter() returns matching elements", () => {
      const adapter = createMobXReactivity();
      const array = adapter.createArray([1, 2, 3, 4, 5]);

      const evens = array.filter((item) => item % 2 === 0);

      expect(evens).toEqual([2, 4]);
    });

    it("find() returns first match or undefined", () => {
      const adapter = createMobXReactivity();
      const array = adapter.createArray([10, 20, 30]);

      expect(array.find((item) => item > 15)).toBe(20);
      expect(array.find((item) => item > 100)).toBeUndefined();
    });

    it("pop() removes and returns last element", () => {
      const adapter = createMobXReactivity();
      const array = adapter.createArray([1, 2, 3]);

      const last = array.pop();

      expect(last).toBe(3);
      expect(array.toArray()).toEqual([1, 2]);
      expect(array.length).toBe(2);
    });

    it("replace() replaces all elements", () => {
      const adapter = createMobXReactivity();
      const array = adapter.createArray([1, 2, 3]);

      array.replace([10, 20]);

      expect(array.toArray()).toEqual([10, 20]);
      expect(array.length).toBe(2);
    });

    it("clear() removes all elements", () => {
      const adapter = createMobXReactivity();
      const array = adapter.createArray([1, 2, 3]);

      array.clear();

      expect(array.toArray()).toEqual([]);
      expect(array.length).toBe(0);
    });

    it("get() returns element at index", () => {
      const adapter = createMobXReactivity();
      const array = adapter.createArray(["a", "b", "c"]);

      expect(array.get(0)).toBe("a");
      expect(array.get(1)).toBe("b");
      expect(array.get(2)).toBe("c");
      expect(array.get(5)).toBeUndefined();
    });

    it("[Symbol.iterator]() supports for...of", () => {
      const adapter = createMobXReactivity();
      const array = adapter.createArray([10, 20, 30]);
      const collected: number[] = [];

      for (const item of array) {
        collected.push(item);
      }

      expect(collected).toEqual([10, 20, 30]);
    });
  });

  describe("reaction and disposal", () => {
    it("disposing a reaction stops notifications", () => {
      const adapter = createMobXReactivity();
      const box = adapter.createBox(0);
      const values: number[] = [];

      const dispose = adapter.reaction(
        () => box.get(),
        (value) => values.push(value),
        { fireImmediately: true }
      );

      box.set(1);
      expect(values).toEqual([0, 1]);

      dispose();

      box.set(2);
      box.set(3);
      expect(values).toEqual([0, 1]);
    });

    it("nested batching only fires reaction once", () => {
      const adapter = createMobXReactivity();
      const box = adapter.createBox(0);
      const values: number[] = [];

      const dispose = adapter.reaction(
        () => box.get(),
        (value) => values.push(value)
      );

      adapter.batch(() => {
        box.set(1);
        adapter.batch(() => {
          box.set(2);
          box.set(3);
        });
        box.set(4);
      });

      expect(values).toEqual([4]);
      dispose();
    });
  });

  describe("error handling", () => {
    it("computed value updates when dependency changes", () => {
      const adapter = createMobXReactivity();
      const firstName = adapter.createBox("John");
      const lastName = adapter.createBox("Doe");
      const fullName = adapter.computed(
        () => `${firstName.get()} ${lastName.get()}`
      );
      const names: string[] = [];

      const dispose = adapter.reaction(
        () => fullName.get(),
        (value) => names.push(value),
        { fireImmediately: true }
      );

      expect(names).toEqual(["John Doe"]);

      firstName.set("Jane");
      expect(names).toEqual(["John Doe", "Jane Doe"]);

      lastName.set("Smith");
      expect(names).toEqual(["John Doe", "Jane Doe", "Jane Smith"]);

      dispose();
    });
  });
});
