import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { Ajv2020 as Ajv } from "ajv/dist/2020.js";

import {
  corpusDir,
  DRIVER_PROTOCOL_VERSION,
  loadCapabilityManifests,
  loadManifest,
  loadScenarios,
  loadSchema,
  loadVectors,
  supports,
} from "../src/index.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = {
  capabilities: ajv.compile(loadSchema("capabilities") as object),
  scenario: ajv.compile(loadSchema("scenario") as object),
  vector: ajv.compile(loadSchema("vector") as object),
};

const fail = (errors: unknown): string => JSON.stringify(errors, null, 2);

describe("vectors", () => {
  const vectors = loadVectors();

  it("is not empty", () => {
    expect(vectors.size).toBeGreaterThan(0);
  });

  for (const [stem, file] of vectors) {
    it(`${stem} matches vector.schema.json`, () => {
      expect(
        validators.vector(file),
        fail(validators.vector.errors)
      ).toBeTruthy();
    });

    it(`${stem} has unique case names and a resolvable outcome`, () => {
      const names = file.cases.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
      for (const testCase of file.cases) {
        // A case with neither `expected` nor `throws` asserts nothing at all,
        // which a port would silently treat as passing.
        expect(
          testCase.throws === true || "expected" in testCase,
          `${stem}/${testCase.name} pins no outcome`
        ).toBeTruthy();
      }
    });
  }
});

describe("scenarios", () => {
  const scenarios = loadScenarios();

  it("is not empty", () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  it("has unique ids matching their filenames", () => {
    const stems = readdirSync(join(corpusDir, "scenarios"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""))
      .toSorted();
    expect(scenarios.map((s) => s.id).toSorted()).toEqual(stems);
  });

  for (const scenario of scenarios) {
    it(`${scenario.id} matches scenario.schema.json`, () => {
      expect(
        validators.scenario(scenario),
        fail(validators.scenario.errors)
      ).toBeTruthy();
    });

    it(`${scenario.id} only names models it declares`, () => {
      const declared = new Set(scenario.models.map((model) => model.name));
      const named: string[] = [];
      for (const step of scenario.steps) {
        if (step.op === "mutate") {
          named.push(step.model);
        } else if (step.op === "respondBootstrap") {
          named.push(...step.rows.map((row) => row.model));
        } else if (step.op === "respondDeltas" || step.op === "deliverDelta") {
          named.push(...step.packet.actions.map((a) => a.modelName));
        } else if (step.op === "expect") {
          named.push(...(step.store ?? []).map((row) => row.model));
          named.push(...(step.storeAbsent ?? []).map((row) => row.model));
        }
      }
      for (const row of scenario.given?.rows ?? []) {
        named.push(row.model);
      }
      expect([...new Set(named)].filter((n) => !declared.has(n))).toEqual([]);
    });

    it(`${scenario.id} asserts something`, () => {
      expect(scenario.steps.some((step) => step.op === "expect")).toBeTruthy();
    });
  }
});

describe("capability manifests", () => {
  const manifests = loadCapabilityManifests();

  for (const [id, manifest] of manifests) {
    it(`${id} matches capabilities.schema.json`, () => {
      expect(
        validators.capabilities(manifest),
        fail(validators.capabilities.errors)
      ).toBeTruthy();
    });

    it(`${id} speaks the current driver protocol`, () => {
      expect(manifest.protocolVersion).toBe(DRIVER_PROTOCOL_VERSION);
    });
  }

  it("skips rather than fails an artifact an implementation does not declare", () => {
    const ts = manifests.get("stratasync-ts");
    expect(ts).toBeDefined();
    if (!ts) {
      return;
    }
    expect(supports(ts, ["bootstrap"])).toBeTruthy();
    expect(supports(ts)).toBeTruthy();
    expect(supports(ts, ["crdt"])).toBeFalsy();
  });
});

describe("manifest.json", () => {
  const manifest = loadManifest();

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    });

  it("is current — run `npm run corpus:manifest` after editing the corpus", () => {
    const expected = Object.fromEntries(
      walk(corpusDir)
        .filter((path) => path !== join(corpusDir, "manifest.json"))
        .map((path) => [
          relative(corpusDir, path).split(sep).join("/"),
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        ])
        .toSorted(([a], [b]) => (a < b ? -1 : 1))
    );
    expect(manifest.files).toEqual(expected);
  });

  it("pins the driver protocol version the types declare", () => {
    expect(manifest.protocolVersion).toBe(DRIVER_PROTOCOL_VERSION);
  });
});
