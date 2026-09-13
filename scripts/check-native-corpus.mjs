import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const canonical = join(root, "packages/conformance/corpus");
const swift = join(
  root,
  "packages/stratasync-swift/Tests/StrataSyncTests/Resources/corpus"
);
const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
const manifest = JSON.parse(
  readFileSync(join(canonical, "manifest.json"), "utf8")
);
for (const [path, expected] of Object.entries(manifest.files)) {
  assert.equal(
    createHash("sha256")
      .update(readFileSync(join(canonical, path)))
      .digest("hex"),
    expected,
    `Canonical corpus hash changed: ${path}. Format corpus, then regenerate its manifest.`
  );
}
assert.deepEqual(
  files(canonical)
    .map((path) => relative(canonical, path))
    .toSorted(),
  [...Object.keys(manifest.files), "manifest.json"].toSorted(),
  "Corpus manifest omits a file"
);
if (process.argv.includes("--sync")) {
  rmSync(swift, { force: true, recursive: true });
  cpSync(canonical, swift, { recursive: true });
}
assert.deepEqual(
  files(swift)
    .map((path) => relative(swift, path))
    .toSorted(),
  files(canonical)
    .map((path) => relative(canonical, path))
    .toSorted(),
  "Swift corpus file inventory differs; run npm run native:corpus:sync"
);
for (const path of files(canonical)) {
  const name = relative(canonical, path);
  assert.ok(
    readFileSync(path).equals(readFileSync(join(swift, name))),
    `Stale Swift corpus ${name}; run npm run native:corpus:sync`
  );
}
process.stdout.write(
  `Native corpus matches canonical ${manifest.version}; ${Object.keys(manifest.files).length} hashed files.\n`
);
