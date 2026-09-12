/**
 * Regenerates `corpus/manifest.json`: the corpus version plus a SHA-256 of
 * every corpus file, so a port that vendors a copy can prove it is in sync.
 *
 * Run with `npm run corpus:manifest --workspace=packages/conformance`.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpusDir = join(packageDir, "corpus");
const manifestPath = join(corpusDir, "manifest.json");

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return walk(path);
    }
    return path === manifestPath ? [] : [path];
  });

const { version } = JSON.parse(
  readFileSync(join(packageDir, "package.json"), "utf8")
) as { version: string };

const { protocolVersion } = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  protocolVersion: number;
};

const files = Object.fromEntries(
  walk(corpusDir)
    .map(
      (path) =>
        [
          relative(corpusDir, path).split(sep).join("/"),
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        ] as const
    )
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
);

writeFileSync(
  manifestPath,
  `${JSON.stringify({ files, protocolVersion, version }, null, 2)}\n`
);

process.stdout.write(
  `corpus manifest: ${Object.keys(files).length} files at v${version}\n`
);
