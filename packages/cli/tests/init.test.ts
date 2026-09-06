import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { init } from "../src/index";

const templateDir = join(import.meta.dirname, "..", "template");

const readJson = async (file: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;

describe("stratasync init", () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "stratasync-init-"));
  });

  afterEach(async () => {
    await rm(work, { force: true, recursive: true });
  });

  it("dry-run lists files and writes nothing", async () => {
    const dir = join(work, "my-app");
    const result = await init({
      dir,
      dryRun: true,
      templateDir,
      version: "9.9.9",
    });

    expect(result.dryRun).toBeTruthy();
    expect(result.files).toContain("api/package.json");
    expect(result.files).toContain("web/package.json");
    expect(result.files).toContain(".gitignore");
    await expect(stat(dir)).rejects.toThrow();
  });

  it("scaffolds workspaces with @stratasync pinned to the given version", async () => {
    const dir = join(work, "my-app");
    const result = await init({ dir, templateDir, version: "9.9.9" });

    const root = await readJson(join(dir, "package.json"));
    const api = await readJson(join(dir, "api/package.json"));
    const web = await readJson(join(dir, "web/package.json"));

    expect(result.name).toBe("my-app");
    expect(root.name).toBe("my-app");
    expect(root.workspaces).toEqual(["api", "web"]);
    expect(api.name).toBe("my-app-api");
    expect(web.name).toBe("my-app-web");
    expect(
      (api.dependencies as Record<string, string>)["@stratasync/server"]
    ).toBe("^9.9.9");
    expect(
      (web.dependencies as Record<string, string>)["@stratasync/client"]
    ).toBe("^9.9.9");
    expect(JSON.stringify(api).includes('"*"')).toBeFalsy();

    // dotfiles restored, secrets seeded from the example, nothing extended
    await expect(stat(join(dir, ".gitignore"))).resolves.toBeTruthy();
    await expect(stat(join(dir, "api/.env"))).resolves.toBeTruthy();
    const tsconfig = await readJson(join(dir, "api/tsconfig.json"));
    expect(tsconfig.extends).toBeUndefined();
    expect(
      (tsconfig.compilerOptions as Record<string, unknown>).strict
    ).toBeTruthy();
  });

  it("refuses a non-empty directory unless forced", async () => {
    const dir = join(work, "taken");
    await init({ dir, templateDir, version: "9.9.9" });
    await writeFile(join(dir, "notes.txt"), "keep me");

    await expect(init({ dir, templateDir, version: "9.9.9" })).rejects.toThrow(
      /--force/
    );
    await expect(
      init({ dir, force: true, templateDir, version: "9.9.9" })
    ).resolves.toBeTruthy();
    await expect(readFile(join(dir, "notes.txt"), "utf8")).resolves.toBe(
      "keep me"
    );
  });

  it("rejects an invalid app name", async () => {
    await expect(
      init({ dir: join(work, "My App!"), templateDir })
    ).rejects.toThrow(/valid app name/);
  });
});
