import {
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface InitOptions {
  /** Target directory, relative to cwd or absolute. */
  dir: string;
  /** Report the plan without writing anything. */
  dryRun?: boolean;
  /** Write into a directory that already has files. */
  force?: boolean;
  /** Override the bundled template; tests point this at a fresh build. */
  templateDir?: string;
  /** Version to pin `@stratasync/*` packages to. Defaults to this package's. */
  version?: string;
}

export interface InitResult {
  dir: string;
  dryRun: boolean;
  files: string[];
  name: string;
  version: string;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const pkgRoot = fileURLToPath(new URL("../", import.meta.url));

const readOwnVersion = async (): Promise<string> => {
  const pkg = JSON.parse(
    await readFile(join(pkgRoot, "package.json"), "utf8")
  ) as {
    version: string;
  };
  return pkg.version;
};

const listFiles = async (dir: string, base = dir): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path, base)));
    } else {
      files.push(path.slice(base.length + 1));
    }
  }
  return files.toSorted();
};

const isEmptyDir = async (dir: string): Promise<boolean> => {
  try {
    const entries = await readdir(dir);
    return entries.length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }
};

/** Rewrites one package.json: workspace `*` pins become a real range, names become the app's. */
const rewriteManifest = async (
  file: string,
  { name, version }: { name: string; version: string }
): Promise<void> => {
  const pkg = JSON.parse(await readFile(file, "utf8")) as Record<
    string,
    unknown
  >;
  if (pkg.name === "__APP_NAME__") {
    pkg.name = name;
  } else if (
    typeof pkg.name === "string" &&
    pkg.name.startsWith("@stratasync/example-")
  ) {
    pkg.name = `${name}-${pkg.name.slice("@stratasync/example-".length)}`;
  }
  for (const section of ["dependencies", "devDependencies"]) {
    const deps = pkg[section];
    if (deps && typeof deps === "object") {
      for (const [dep, range] of Object.entries(
        deps as Record<string, string>
      )) {
        if (dep.startsWith("@stratasync/") && range === "*") {
          (deps as Record<string, string>)[dep] = `^${version}`;
        }
      }
    }
  }
  await writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`);
};

const restoreDotfiles = async (dir: string): Promise<void> => {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await restoreDotfiles(path);
    } else if (entry.name === "_gitignore") {
      await rename(path, join(dir, ".gitignore"));
    }
  }
};

/**
 * Scaffolds a Strata Sync app into `dir`: a Fastify + Postgres sync server in
 * `api/` and a React client in `web/`, as npm workspaces.
 */
export const init = async (options: InitOptions): Promise<InitResult> => {
  const dir = resolve(options.dir);
  const name = basename(dir);
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `"${name}" is not a valid app name. Use lowercase letters, digits, ".", "_" or "-", and start with a letter or digit.`
    );
  }
  const templateDir = options.templateDir ?? join(pkgRoot, "template");
  try {
    await stat(join(templateDir, "package.json"));
  } catch {
    throw new Error(
      `Template not found at ${templateDir}. If you are running from a checkout, run \`npm run build\` in packages/cli first.`
    );
  }
  if (!(options.force || (await isEmptyDir(dir)))) {
    throw new Error(
      `${dir} already has files. Pass --force to write into it anyway, or choose an empty directory.`
    );
  }
  const version = options.version ?? (await readOwnVersion());
  const templateFiles = await listFiles(templateDir);
  const files = templateFiles.map((file) =>
    file.endsWith("_gitignore")
      ? file.replace(/_gitignore$/, ".gitignore")
      : file
  );

  if (options.dryRun) {
    return { dir, dryRun: true, files, name, version };
  }

  await mkdir(dir, { recursive: true });
  await cp(templateDir, dir, { recursive: true });
  await restoreDotfiles(dir);
  for (const manifest of [
    "package.json",
    "api/package.json",
    "web/package.json",
  ]) {
    await rewriteManifest(join(dir, manifest), { name, version });
  }
  // The example ships its DATABASE_URL as .env.example; copying it in means
  // `npm run db:up` and `npm run dev:api` work with nothing else to edit.
  try {
    await cp(join(dir, "api/.env.example"), join(dir, "api/.env"));
  } catch {
    // no example env in the template; nothing to seed
  }
  return { dir, dryRun: false, files, name, version };
};
