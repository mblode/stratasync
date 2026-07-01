import { CachedPromise } from "../../src/model/cached-promise.js";
import { makeCachedReferenceModelProperty } from "../../src/model/observability.js";

interface ReferenceStore {
  get: (modelName: string, id: string) => unknown | Promise<unknown>;
}

// Builds a host object with a cached-reference property `author` backed by the
// `authorId` foreign key and a swappable `store`.
const makeHost = (store: ReferenceStore) => {
  const proto = {};
  makeCachedReferenceModelProperty(proto, "author", "authorId", "User");
  const host = Object.create(proto) as {
    author: CachedPromise<unknown>;
    authorId: string | null;
    store: ReferenceStore;
  };
  host.store = store;
  return host;
};

describe(makeCachedReferenceModelProperty, () => {
  it("retries after a cached promise rejects instead of replaying it", async () => {
    let calls = 0;
    const host = makeHost({
      get(_modelName, id) {
        calls += 1;
        if (calls === 1) {
          return new CachedPromise(Promise.reject(new Error("boom")));
        }
        return CachedPromise.resolve({ id, name: "Ada" });
      },
    });
    host.authorId = "u1";

    const first = host.author;
    await expect(first).rejects.toThrow("boom");

    const second = host.author;
    expect(second).not.toBe(first);
    expect(await second).toEqual({ id: "u1", name: "Ada" });
    expect(calls).toBe(2);
  });

  it("caches the promise while it is still pending", () => {
    const host = makeHost({
      get() {
        return new CachedPromise(Promise.race([]));
      },
    });
    host.authorId = "u1";

    expect(host.author).toBe(host.author);
  });

  it("copies the id synchronously when assigned a pending promise", () => {
    const host = makeHost({ get: () => null });
    const pending = new CachedPromise(Promise.race([]), "u2");

    host.author = pending;

    expect(host.authorId).toBe("u2");
  });

  it("clears the FK to null when assigned a resolved-empty promise", () => {
    const host = makeHost({ get: () => null });
    host.authorId = "u3";

    host.author = CachedPromise.resolve();

    expect(host.authorId).toBeNull();
  });

  it("copies the id when assigned a fulfilled promise", () => {
    const host = makeHost({ get: () => null });

    host.author = CachedPromise.resolve({ id: "u4", name: "Bob" });

    expect(host.authorId).toBe("u4");
  });

  it("clears the FK to null when assigned null", () => {
    const host = makeHost({ get: () => null });
    host.authorId = "u5";

    host.author = null as unknown as CachedPromise<unknown>;

    expect(host.authorId).toBeNull();
  });
});
