/**
 * The TypeScript side of the shared conformance vectors. Vectors are read off
 * the filesystem from `@stratasync/conformance` rather than inlined, so the
 * Swift and Kotlin ports assert the same bytes. When one of these fails, fix
 * the implementation, not the vector.
 */
import { loadVectorFile } from "@stratasync/conformance";

import {
  parseBootstrapLine,
  parseDeltaPacket,
  parseSyncAction,
} from "../src/protocol/index.js";
import { readNdjsonLines } from "../src/protocol/ndjson.js";
import { computeSchemaHash } from "../src/schema/hash.js";
import {
  MODEL_SNAPSHOT_VERSION,
  serializeModelSnapshot,
} from "../src/schema/snapshot.js";
import type { ModelRegistrySnapshot } from "../src/schema/types.js";
import { compareSyncId, parseSyncId } from "../src/sync/sync-id.js";

/**
 * Corpus values are JSON, so a returned date is compared as its ISO-8601 UTC
 * string and a key the implementation left `undefined` is compared as an
 * absent key — a port has no second empty value to distinguish it from one.
 */
const toCorpusValue = (value: unknown): unknown => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(toCorpusValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, member]) => member !== undefined)
        .map(([key, member]) => [key, toCorpusValue(member)])
    );
  }
  return value;
};

/**
 * Runs one vector file against a synchronous function. `input` is always an
 * array of positional arguments in these files.
 */
const describeVectors = (
  stem: string,
  call: (args: unknown[]) => unknown
): void => {
  const file = loadVectorFile(stem);

  describe(`${file.fn} vectors`, () => {
    for (const testCase of file.cases) {
      const args = testCase.input as unknown[];

      it(testCase.name, () => {
        if (testCase.throws === true) {
          expect(() => call(args)).toThrow();
          return;
        }
        expect(toCorpusValue(call(args))).toStrictEqual(testCase.expected);
      });
    }
  });
};

describeVectors("compare-sync-id", (args) =>
  // The vector pins the sign; the magnitude is an implementation detail.
  Math.sign(compareSyncId(args[0] as string, args[1] as string))
);

describeVectors("parse-sync-id", (args) =>
  parseSyncId(args[0], args[1] as string | undefined)
);

describeVectors("parse-sync-action", (args) =>
  parseSyncAction(args[0] as Record<string, unknown>)
);

describeVectors("parse-delta-packet", (args) => parseDeltaPacket(args[0]));

describeVectors("parse-bootstrap-line", (args) =>
  parseBootstrapLine(args[0] as string)
);

const streamFromChunks = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index] as string));
        index += 1;
      } else {
        controller.close();
      }
    },
  });
};

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

describe("readNdjsonLines vectors", () => {
  const file = loadVectorFile("read-ndjson-lines");

  for (const testCase of file.cases) {
    const [chunks] = testCase.input as [string[]];

    it(testCase.name, async () => {
      const lines: string[] = [];
      for await (const line of readNdjsonLines(streamFromChunks(chunks))) {
        lines.push(line);
      }
      expect(lines).toStrictEqual(testCase.expected);
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
