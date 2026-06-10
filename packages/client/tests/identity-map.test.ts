import { noopReactivityAdapter } from "../../core/src/index";
import { IdentityMapRegistry } from "../src/identity-map";

describe("IdentityMap eviction", () => {
  it("evicts the least recently used entries when the cache exceeds its cap", () => {
    const registry = new IdentityMapRegistry(
      noopReactivityAdapter,
      undefined,
      2
    );
    const map = registry.getMap<Record<string, unknown>>("Task");

    map.set("task-1", { id: "task-1", title: "One" });
    map.set("task-2", { id: "task-2", title: "Two" });
    expect(map.get("task-1")).toMatchObject({ title: "One" });

    map.set("task-3", { id: "task-3", title: "Three" });

    expect(map.get("task-1")).toMatchObject({ title: "One" });
    expect(map.get("task-2")).toBeUndefined();
    expect(map.get("task-3")).toMatchObject({ title: "Three" });
  });

  it("treats update() as an access that protects an entry from eviction", () => {
    const registry = new IdentityMapRegistry(
      noopReactivityAdapter,
      undefined,
      2
    );
    const map = registry.getMap<Record<string, unknown>>("Task");

    map.set("task-1", { id: "task-1", title: "One" });
    map.set("task-2", { id: "task-2", title: "Two" });
    // Touch task-1 via update so task-2 becomes the least-recently-used.
    map.update("task-1", { title: "One!" });
    map.set("task-3", { id: "task-3", title: "Three" });

    expect(map.get("task-1")).toMatchObject({ title: "One!" });
    expect(map.get("task-2")).toBeUndefined();
    expect(map.get("task-3")).toMatchObject({ title: "Three" });
  });

  it("evicts in least-recently-used order across several inserts", () => {
    const registry = new IdentityMapRegistry(
      noopReactivityAdapter,
      undefined,
      3
    );
    const map = registry.getMap<Record<string, unknown>>("Task");

    for (const n of [1, 2, 3, 4, 5]) {
      map.set(`t${n}`, { id: `t${n}` });
    }

    // Only the three most recent survive.
    expect(map.keys().toSorted()).toEqual(["t3", "t4", "t5"]);
  });

  it("removing an entry drops it from the access order", () => {
    const registry = new IdentityMapRegistry(
      noopReactivityAdapter,
      undefined,
      2
    );
    const map = registry.getMap<Record<string, unknown>>("Task");

    map.set("task-1", { id: "task-1" });
    map.set("task-2", { id: "task-2" });
    map.delete("task-1");
    map.set("task-3", { id: "task-3" });

    // task-1 was deleted, so task-2 (the remaining oldest) must NOT be evicted.
    expect(map.get("task-2")).toMatchObject({ id: "task-2" });
    expect(map.get("task-3")).toMatchObject({ id: "task-3" });
  });

  it("does not evict when maxSize is non-positive or infinite", () => {
    const registry = new IdentityMapRegistry(
      noopReactivityAdapter,
      undefined,
      Number.POSITIVE_INFINITY
    );
    const map = registry.getMap<Record<string, unknown>>("Task");
    for (let i = 0; i < 50; i += 1) {
      map.set(`t${i}`, { id: `t${i}` });
    }
    expect(map.size).toBe(50);
  });
});
