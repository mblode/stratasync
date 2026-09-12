/**
 * The TypeScript side of the shared conformance vectors. Vectors are read off
 * the filesystem from `@stratasync/conformance` rather than inlined, so the
 * Swift and Kotlin ports assert the same bytes. When one of these fails, fix
 * the implementation, not the vector.
 */
import { loadVectorFile } from "@stratasync/conformance";

import { compareSyncId } from "../src/sync/sync-id.js";

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
