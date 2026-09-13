import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const separator = process.argv.indexOf("--");
assert.ok(separator !== -1, "Pass the driver command after --");
const [command, ...args] = process.argv.slice(separator + 1);
assert.ok(command, "Driver executable is required");
const scenario = JSON.parse(
  readFileSync(
    new URL(
      "../packages/conformance/corpus/scenarios/bootstrap-then-delta.json",
      import.meta.url
    ),
    "utf8"
  )
);
const run = (input) =>
  spawnSync(command, args, {
    encoding: "utf8",
    input,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
  });
const healthy = run(JSON.stringify(scenario));
assert.equal(healthy.status, 0, healthy.stderr);
assert.equal(JSON.parse(healthy.stdout).ok, true, healthy.stdout);
// Deliberately false: a cold engine is disconnected.
scenario.steps[0].state = "syncing";
const broken = run(JSON.stringify(scenario));
assert.equal(
  broken.status,
  0,
  `Scenario verdict must not be the process exit status: ${broken.stderr}`
);
assert.equal(
  JSON.parse(broken.stdout).ok,
  false,
  "Driver accepted an intentionally wrong expectation"
);
const malformed = run("{");
assert.notEqual(
  malformed.status,
  0,
  "Malformed JSON must fail driver execution"
);
process.stdout.write(
  "Driver protocol passed: valid scenario, false verdict, malformed input.\n"
);
