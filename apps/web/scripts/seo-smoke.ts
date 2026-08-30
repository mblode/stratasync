/**
 * Keeps the qualified search positioning consistent across browser, schema,
 * documentation, social, and agent-readable surfaces.
 *
 *   npm run smoke:seo
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { siteConfig, zoneRootJsonLd } from "../lib/config.ts";

const read = (relativePath: string) =>
  readFileSync(path.join(process.cwd(), relativePath), "utf8");

assert.ok(siteConfig.title.startsWith(siteConfig.heading));
assert.ok(siteConfig.title.length <= 60, "title exceeds 60 characters");
assert.match(siteConfig.heading, /^Local-first sync engine for TypeScript$/u);
assert.match(siteConfig.description, /local-first TypeScript/u);
assert.match(siteConfig.answer, /developer library for application data sync/u);
assert.match(siteConfig.answer, /not a network-management platform/u);

const schema = JSON.stringify(zoneRootJsonLd);
assert.match(schema, new RegExp(siteConfig.heading, "u"));
assert.match(schema, new RegExp(siteConfig.answer, "u"));
assert.match(schema, /offline-first TypeScript/u);

const page = read("app/page.tsx");
assert.ok(
  page.indexOf("{siteConfig.heading}") < page.indexOf("{siteConfig.answer}"),
  "homepage must lead with the qualified H1 before the direct answer"
);

const markdown = read("app/well-known/home-markdown/route.ts");
assert.ok(
  markdown.search(/# \$\{siteConfig\.heading\}/u) <
    markdown.search(/\$\{siteConfig\.answer\}/u),
  "agent-readable homepage must lead with the qualified H1 before the answer"
);

const docsHome = read("../docs/index.mdx");
assert.match(docsHome, /title: Local-first sync engine for TypeScript/u);
assert.match(docsHome, /not a network-management platform/u);

const openGraph = read("app/opengraph-image.tsx");
assert.match(openGraph, /title: "Local-first sync engine for TypeScript"/u);

process.stdout.write("seo smoke ok\n");
