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
});
