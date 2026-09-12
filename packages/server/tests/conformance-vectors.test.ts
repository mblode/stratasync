/**
 * The server side of the shared conformance vectors: the wire codecs a port
 * has to match byte for byte. Vectors are read off the filesystem from
 * `@stratasync/conformance` rather than inlined, so the Swift and Kotlin ports
 * assert the same bytes. When one of these fails, fix the implementation, not
 * the vector.
 */
import { loadVectorFile } from "@stratasync/conformance";

import { parseSyncActionOutput } from "../src/core/sync-action.js";
import type { FieldSpec } from "../src/mutate/field-codecs.js";
import {
  buildInsertData,
  buildUpdateData,
  parseTemporalInput,
  serializeSyncData,
} from "../src/mutate/field-codecs.js";
import type { GraphQLTransactionAction } from "../src/types.js";
import { mapGraphQLAction } from "../src/types.js";

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

type Record_ = Record<string, unknown>;
type FieldSpecs = Record<string, FieldSpec>;

describeVectors("map-graphql-action", (args) =>
  mapGraphQLAction(args[0] as GraphQLTransactionAction)
);

describeVectors("parse-sync-action-output", (args) =>
  parseSyncActionOutput(args[0])
);

describeVectors("parse-temporal-input", (args) =>
  parseTemporalInput(
    args[0] as "dateOnly" | "instant",
    args[1],
    args[2] as string
  )
);

describeVectors("build-insert-data", (args) =>
  buildInsertData(
    args[0] as string | null,
    args[1] as Record_,
    args[2] as FieldSpecs
  )
);

describeVectors("build-update-data", (args) =>
  buildUpdateData(
    args[0] as Record_,
    new Set(args[1] as string[]),
    args[2] as FieldSpecs
  )
);

describeVectors("serialize-sync-data", (args) =>
  serializeSyncData(
    args[0] as Record_,
    args[1] as FieldSpecs,
    args[2] as { keys?: string[]; modelId?: string | null } | undefined
  )
);
