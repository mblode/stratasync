#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";

import { isCancel, text } from "@clack/prompts";
import { Command } from "commander";

import { init } from "./init.js";

// stdout carries data only; stderr carries logs, progress and hints.
const isInteractive =
  Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && !process.env.CI;
const paint = (style: Parameters<typeof styleText>[0], value: string): string =>
  isInteractive ? styleText(style, value) : value;

const { version } = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../package.json", import.meta.url)),
    "utf8"
  )
) as { version: string };

const program = new Command();

program
  .name("stratasync")
  .description("Scaffold and work with Strata Sync apps")
  .version(version)
  .option("--output <format>", "output format: text or json", "text")
  .option("--no-input", "never prompt; fail if a required value is missing");

interface InitFlags {
  dryRun?: boolean;
  force?: boolean;
}

program
  .command("init [dir]")
  .description(
    "Create a new Strata Sync app: a sync server in api/ and a React client in web/"
  )
  .option("--force", "write into a directory that already has files")
  .option("--dry-run", "list the files that would be written, without writing")
  .action(async (dirArg: string | undefined, flags: InitFlags) => {
    const { input, output } = program.opts<{
      input: boolean;
      output: string;
    }>();
    let dir = dirArg;
    if (!dir) {
      if (!(input && process.stdin.isTTY)) {
        throw new Error(
          "Missing directory. Pass it as an argument: stratasync init my-app"
        );
      }
      const answer = await text({
        defaultValue: "my-app",
        message: "Where should the app go?",
        placeholder: "my-app",
      });
      if (isCancel(answer)) {
        process.exitCode = 1;
        return;
      }
      dir = answer;
    }

    const result = await init({
      dir,
      dryRun: flags.dryRun,
      force: flags.force,
    });

    if (output === "json") {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }

    const shown = relative(process.cwd(), result.dir) || ".";
    if (result.dryRun) {
      process.stderr.write(
        `Would write ${result.files.length} files to ${shown}\n`
      );
      process.stdout.write(`${result.files.join("\n")}\n`);
      return;
    }
    process.stderr.write(
      [
        "",
        `${paint("green", "Created")} ${result.name} in ${shown} (${result.files.length} files, @stratasync/* ^${result.version})`,
        "",
        "Next steps:",
        `  cd ${shown}`,
        "  npm install",
        "  npm run db:up      # Postgres in Docker",
        "  npm run db:push    # create the tables",
        "  npm run dev:api    # sync server",
        "  npm run dev:web    # React client, in a second terminal",
        "",
        `Docs: ${paint("underline", "https://blode.co/stratasync/docs/getting-started")}`,
        "",
      ].join("\n")
    );
  });

try {
  await program.parseAsync();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (program.opts<{ output: string }>().output === "json") {
    process.stdout.write(
      `${JSON.stringify({ code: "INIT_FAILED", details: {}, error: true, message })}\n`
    );
  } else {
    process.stderr.write(`${paint("red", "Error:")} ${message}\n`);
  }
  process.exitCode = 1;
}
