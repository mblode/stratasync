import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { siteConfig } from "@/lib/config";

/**
 * The docs live in `apps/docs` and deploy to Blode.md, which serves them back
 * under `blode.co/stratasync/docs`. `docs.json` is the single list of what
 * exists, so the sitemap and the landing page read it here rather than keeping
 * a second copy that drifts.
 *
 * Every page below was reachable only through Blode.md's client-rendered
 * sidebar: the zone sitemap listed two URLs and the landing page linked one,
 * so 36 docs URLs had no crawl path Google would follow.
 *
 * Read from disk at build time. `app/sitemap.ts` and `app/page.tsx` are both
 * statically prerendered, so this never runs in a deployed function where
 * `apps/docs` is absent. A missing or malformed file throws and fails the
 * build on purpose: the failure this replaces was a sitemap that silently
 * shrank back to two URLs.
 */
const DOCS_DIR = join(process.cwd(), "..", "docs");

interface DocsNavGroup {
  group: string;
  pages: string[];
  root?: string;
}

export interface DocsPage {
  description: string;
  slug: string;
  title: string;
  url: string;
}

export interface DocsGroup {
  group: string;
  pages: DocsPage[];
}

/** `index` is served at `/docs`; every other slug hangs off it. */
const slugToUrl = (slug: string): string =>
  slug === "index"
    ? `${siteConfig.url}/docs`
    : `${siteConfig.url}/docs/${slug}`;

/**
 * Minimal YAML front matter reader: these files only ever carry `title` and
 * `description` as single-line scalars, so a parser dependency would earn
 * nothing. Values are used as text, never as YAML.
 */
const readFrontMatter = (
  slug: string
): { description: string; title: string } => {
  // A slug is either a file (`guides/offline-first.mdx`) or a directory with
  // an index (`architecture/index.mdx`); docs.json does not say which.
  const raw = existsSync(join(DOCS_DIR, `${slug}.mdx`))
    ? readFileSync(join(DOCS_DIR, `${slug}.mdx`), "utf8")
    : readFileSync(join(DOCS_DIR, slug, "index.mdx"), "utf8");
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const block = match?.[1] ?? "";
  const field = (name: string): string => {
    const line = block
      .split(/\r?\n/)
      .find((entry) => entry.startsWith(`${name}:`));
    const value = line?.slice(name.length + 1).trim() ?? "";
    return value.replaceAll(/^["']|["']$/g, "");
  };

  return { description: field("description"), title: field("title") };
};

const readGroups = (): DocsGroup[] => {
  const parsed = JSON.parse(
    readFileSync(join(DOCS_DIR, "docs.json"), "utf8")
  ) as { navigation?: { groups?: DocsNavGroup[] } };

  const seen = new Set<string>();

  return (parsed.navigation?.groups ?? []).map((group) => ({
    group: group.group,
    // A group with a `root` also publishes that root as its own page; the
    // Blode.md sitemap serves `packages/core` alongside `packages/core/models`.
    pages: [...(group.root ? [group.root] : []), ...group.pages]
      .filter((slug) => {
        if (seen.has(slug)) {
          return false;
        }
        seen.add(slug);
        return true;
      })
      .map((slug) => ({
        slug,
        url: slugToUrl(slug),
        ...readFrontMatter(slug),
      })),
  }));
};

export const docsGroups: DocsGroup[] = readGroups();

export const docsPages: DocsPage[] = docsGroups.flatMap((group) => group.pages);
