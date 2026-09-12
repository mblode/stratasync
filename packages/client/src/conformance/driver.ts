#!/usr/bin/env node
/**
 * The TypeScript conformance driver.
 *
 * Speaks the stdin/stdout protocol in `packages/conformance/corpus/README.md`:
 * one JSON scenario in, one JSON result out, nothing else on stdout. A Swift or
 * Kotlin runner invokes this the same way the Vitest suite does:
 *
 *   npm run build --workspace=packages/client
 *   node packages/client/dist/conformance/driver.js run < scenario.json
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { corpusDir, DRIVER_PROTOCOL_VERSION } from "@stratasync/conformance";
import type { Scenario } from "@stratasync/conformance";

import { runScenario } from "./runner.js";

const DRIVER_NAME = "stratasync-ts";

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const emit = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const main = async (): Promise<number> => {
  const command = process.argv.at(2);

  if (command === "version") {
    emit({ driver: DRIVER_NAME, protocolVersion: DRIVER_PROTOCOL_VERSION });
    return 0;
  }

  if (command === "capabilities") {
    emit(
      JSON.parse(
        readFileSync(
          join(corpusDir, "capabilities", `${DRIVER_NAME}.json`),
          "utf8"
        )
      )
    );
    return 0;
  }

  if (command !== "run") {
    process.stderr.write(
      `Usage: driver <capabilities|run|version>; got ${String(command)}\n`
    );
    return 2;
  }

  const input = await readStdin();
  let scenario: Scenario;
  try {
    scenario = JSON.parse(input) as Scenario;
  } catch (error) {
    emit({
      error: `Invalid scenario JSON: ${error instanceof Error ? error.message : String(error)}`,
      ok: false,
      scenarioId: "<unparsed>",
      steps: [],
    });
    return 1;
  }

  const result = await runScenario(scenario);
  emit(result);
  return result.ok ? 0 : 1;
};

main()
  // oxlint-disable-next-line prefer-await-to-then -- top-level entry point
  .then((code) => {
    process.exitCode = code;
  })
  // oxlint-disable-next-line prefer-await-to-then, prefer-await-to-callbacks -- top-level entry point
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`
    );
    process.exitCode = 70;
  });
