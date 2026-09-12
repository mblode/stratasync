import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Capability,
  CapabilityManifest,
  CorpusManifest,
  Scenario,
  VectorFile,
} from "./types.js";

export * from "./types.js";

/**
 * Absolute path to the corpus. `src/` and `dist/` sit at the same depth, so
 * this resolves the same whether the package is consumed from source or built.
 */
export const corpusDir: string = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "corpus"
);

const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8")) as T;

const listJson = (dir: string): string[] =>
  readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();

/** Every pure-function vector file, keyed by filename stem. */
export const loadVectors = (): Map<string, VectorFile> => {
  const dir = join(corpusDir, "vectors");
  return new Map(
    listJson(dir).map((name) => [
      name.replace(/\.json$/, ""),
      readJson<VectorFile>(join(dir, name)),
    ])
  );
};

/** One vector file by its filename stem. Throws if it does not exist. */
export const loadVectorFile = (stem: string): VectorFile =>
  readJson<VectorFile>(join(corpusDir, "vectors", `${stem}.json`));

/** Every engine scenario, in filename order. */
export const loadScenarios = (): Scenario[] => {
  const dir = join(corpusDir, "scenarios");
  return listJson(dir).map((name) => readJson<Scenario>(join(dir, name)));
};

/** Every declared implementation capability manifest, keyed by implementation id. */
export const loadCapabilityManifests = (): Map<string, CapabilityManifest> => {
  const dir = join(corpusDir, "capabilities");
  return new Map(
    listJson(dir).map((name) => {
      const manifest = readJson<CapabilityManifest>(join(dir, name));
      return [manifest.implementation, manifest];
    })
  );
};

export const loadManifest = (): CorpusManifest =>
  readJson<CorpusManifest>(join(corpusDir, "manifest.json"));

/** The JSON Schema for one artifact kind, for validating the corpus itself. */
export const loadSchema = (
  kind: "scenario" | "vector" | "capabilities"
): unknown => readJson(join(corpusDir, "schemas", `${kind}.schema.json`));

/**
 * Whether an implementation may be held to an artifact. An artifact with no
 * `requires` applies to everyone — that is the default on purpose, so opting
 * out is a deliberate edit rather than an omission.
 */
export const supports = (
  manifest: CapabilityManifest,
  requires: Capability[] | undefined
): boolean =>
  (requires ?? []).every((capability) =>
    manifest.capabilities.includes(capability)
  );
