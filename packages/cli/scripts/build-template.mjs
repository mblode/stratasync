/*
 * Builds `template/` from the runnable examples, so `stratasync init` ships
 * the same app the repo tests rather than a second copy that drifts.
 *
 * Runs at build and before tests. Excludes build output, secrets and turbo
 * state, inlines the root tsconfig each example extends so the scaffolded app
 * stands alone, and stores `.gitignore` as `_gitignore` because npm drops
 * `.gitignore` files from published tarballs.
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "../..");
const examples = resolve(repoRoot, "examples");
const out = resolve(pkgRoot, "template");

const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".turbo", ".tanstack"]);
const EXCLUDED_FILES = new Set([
  ".env",
  ".env.local",
  "tsconfig.tsbuildinfo",
  "bench.html",
]);
const EXCLUDED_SUFFIXES = [".tsbuildinfo"];

const isExcluded = (path) => {
  const rel = relative(examples, path);
  const parts = rel.split("/");
  const name = parts.at(-1) ?? "";
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) {
    return true;
  }
  if (
    EXCLUDED_FILES.has(name) ||
    EXCLUDED_SUFFIXES.some((s) => name.endsWith(s))
  ) {
    return true;
  }
  return rel.endsWith("src/bench.ts");
};

const inlineTsconfig = async (file) => {
  const config = JSON.parse(await readFile(file, "utf8"));
  if (
    typeof config.extends !== "string" ||
    !config.extends.includes("tsconfig.base.json")
  ) {
    return;
  }
  const base = JSON.parse(
    await readFile(resolve(dirname(file), config.extends), "utf8")
  );
  const { extends: _extends, ...rest } = config;
  const merged = {
    ...rest,
    compilerOptions: {
      ...base.compilerOptions,
      ...config.compilerOptions,
    },
  };
  await writeFile(file, `${JSON.stringify(merged, null, 2)}\n`);
};

const renameGitignore = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await renameGitignore(path);
    } else if (entry.name === ".gitignore") {
      await cp(path, join(dir, "_gitignore"));
      await rm(path);
    }
  }
};

export const buildTemplate = async (target = out) => {
  await rm(target, { force: true, recursive: true });
  await mkdir(target, { recursive: true });
  for (const app of ["api", "web"]) {
    await cp(resolve(examples, app), join(target, app), {
      filter: (source) => !isExcluded(source),
      recursive: true,
    });
    await inlineTsconfig(join(target, app, "tsconfig.json"));
  }
  await renameGitignore(target);
  await writeFile(
    join(target, "package.json"),
    `${JSON.stringify(
      {
        name: "__APP_NAME__",
        private: true,
        scripts: {
          build: "npm run build --workspaces --if-present",
          "check-types": "npm run check-types --workspaces --if-present",
          "db:push": "npm run db:push --workspace=api",
          "db:up": "docker compose -f api/docker-compose.yml up -d",
          "dev:api": "npm run dev --workspace=api",
          "dev:web": "npm run dev --workspace=web",
        },
        workspaces: ["api", "web"],
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(target, "_gitignore"),
    "node_modules/\ndist/\n*.tsbuildinfo\n.env\n.env.local\n"
  );
  return target;
};

const invokedDirectly =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const target = await buildTemplate();
  process.stderr.write(
    `template built at ${relative(process.cwd(), target)}\n`
  );
}
