import {
  loadCapabilityManifests,
  loadScenarios,
  supports,
} from "@stratasync/conformance";

import { formatFailure, runScenario } from "../src/conformance/runner";

const manifest = loadCapabilityManifests().get("stratasync-ts");
if (!manifest) {
  throw new Error("Missing capability manifest for stratasync-ts");
}

describe("conformance scenarios", () => {
  const scenarios = loadScenarios();

  it("has scenarios to run", () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  for (const scenario of scenarios) {
    const declared = supports(manifest, scenario.requires);
    const run = declared ? it : it.skip;

    run(`${scenario.id}: ${scenario.description}`, async () => {
      const result = await runScenario(scenario);
      expect(result.ok, formatFailure(result)).toBeTruthy();
    });
  }

  it("declares every capability the scenarios it runs require", () => {
    // A scenario the manifest claims to cover must not require a capability
    // the manifest omits — that is the undeclared subset the corpus exists to
    // prevent. Anything genuinely unsupported must be skipped by `requires`.
    const undeclared = scenarios
      .filter((scenario) => supports(manifest, scenario.requires))
      .flatMap((scenario) => scenario.requires ?? [])
      .filter((capability) => !manifest.capabilities.includes(capability));
    expect([...new Set(undeclared)]).toEqual([]);
  });
});
