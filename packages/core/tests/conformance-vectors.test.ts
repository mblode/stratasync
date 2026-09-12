/**
 * The TypeScript side of the shared conformance vectors. Vectors are read off
 * the filesystem from `@stratasync/conformance` rather than inlined, so the
 * Swift and Kotlin ports assert the same bytes. When one of these fails, fix
 * the implementation, not the vector.
 */
import { loadVectorFile } from "@stratasync/conformance";

import { computeSchemaHash } from "../src/schema/hash.js";
import {
  MODEL_SNAPSHOT_VERSION,
  serializeModelSnapshot,
} from "../src/schema/snapshot.js";
import type { ModelRegistrySnapshot } from "../src/schema/types.js";
import { compareSyncId } from "../src/sync/sync-id.js";

/**
 * Rebuilds an object with its keys in `order`. Insertion order has to come
 * from an explicit list rather than a literal, because oxlint's sort-keys
 * autofix sorts literals — a test that fed pre-sorted input to a sorting
 * function would assert nothing.
 */
const declare = <T>(
  order: string[],
  of: Record<string, T>
): Record<string, T> => Object.fromEntries(order.map((key) => [key, of[key]]));

describe("compareSyncId vectors", () => {
  const file = loadVectorFile("compare-sync-id");

  for (const testCase of file.cases) {
    it(testCase.name, () => {
      const [a, b] = testCase.input as [string, string];
      // The vector pins the sign; the magnitude is an implementation detail.
      expect(Math.sign(compareSyncId(a, b))).toBe(testCase.expected);
    });
  }
});

describe("computeSchemaHash vectors", () => {
  const file = loadVectorFile("compute-schema-hash");

  for (const testCase of file.cases) {
    it(testCase.name, () => {
      const doc = testCase.input as { models: ModelRegistrySnapshot["models"] };
      expect(computeSchemaHash({ models: doc.models })).toBe(testCase.expected);
    });
  }

  it("re-serializing a vector input reproduces it", () => {
    // The documents in the vector are what `serializeModelSnapshot` emits, so
    // feeding one back in has to be a fixed point. This is what stops the
    // corpus and the serializer drifting apart without a test noticing.
    for (const testCase of file.cases) {
      const doc = testCase.input as { models: ModelRegistrySnapshot["models"] };
      expect(serializeModelSnapshot({ models: doc.models })).toEqual({
        models: doc.models,
        snapshotVersion: MODEL_SNAPSHOT_VERSION,
      });
    }
  });

  it("sorts models, properties and keys whatever order they arrive in", () => {
    // `toEqual` above ignores key order, so assert ordering explicitly —
    // otherwise nothing here would catch a serializer that stopped sorting.
    const models = declare<ModelRegistrySnapshot["models"][string]>(
      ["User", "Task"],
      {
        Task: {
          meta: { loadStrategy: "instant", name: "Task" },
          properties: declare(["title", "id"], {
            id: { type: "property" },
            title: { type: "property" },
          }),
        },
        User: {
          meta: { loadStrategy: "instant", name: "User" },
          properties: { id: { type: "property" } },
        },
      }
    );

    expect(Object.keys(models)).toEqual(["User", "Task"]);
    expect(Object.keys(models.User.properties)).toEqual(["id"]);
    expect(Object.keys(models.Task.properties)).toEqual(["title", "id"]);

    const doc = serializeModelSnapshot({ models });

    expect(Object.keys(doc.models)).toEqual(["Task", "User"]);
    expect(Object.keys(doc.models.Task.properties)).toEqual(["id", "title"]);
    expect(Object.keys(doc.models.Task.meta)).toEqual(["loadStrategy", "name"]);
  });

  it("hashes the models projection, not the envelope", () => {
    // `snapshotVersion` is outside the hashed region on purpose: bumping the
    // document format must not re-bootstrap every client. If this fails,
    // someone widened the projection and owes a changeset.
    const snapshot: ModelRegistrySnapshot = {
      models: {
        Task: {
          meta: { loadStrategy: "instant", name: "Task" },
          properties: { id: { type: "property" } },
        },
      },
    };
    const doc = serializeModelSnapshot(snapshot);
    expect(computeSchemaHash({ ...doc, snapshotVersion: 999 })).toBe(
      computeSchemaHash(snapshot)
    );
  });
});
