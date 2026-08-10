/**
 * Guards the `og:site_name` rewrite in `lib/docs-proxy.ts`.
 *
 * Every case asserts the upstream product name is GONE rather than that
 * "Matthew Blode" is present. A rewrite that matches nothing leaves the old
 * value in place, and a present-tense assertion cannot tell that apart from a
 * rewrite that worked. That is not hypothetical: the equivalent patch in
 * `dnd-grid` shipped for a few minutes replacing the whole `<meta>` tag with a
 * mangled one, and "Matthew Blode" was present in the output the whole time.
 *
 * Both attribute orders are covered because the upstream is a platform we do
 * not control. A fixture cannot notice the platform changing by construction,
 * which is what SMOKE_LIVE=1 is for.
 *
 *   npm run smoke:docs-proxy               # fixtures only, no network
 *   SMOKE_LIVE=1 npm run smoke:docs-proxy  # also checks the real upstream
 */

import assert from "node:assert/strict";

import { HOST_SITE_NAME, rewriteDocsBody } from "../lib/docs-proxy.ts";

const UPSTREAM_DOCS_URL = "https://stratasync.blode.md/docs";
const PRODUCT = "Strata Sync";

const OG_SITE_NAME_CASES = [
  `<meta property="og:site_name" content="${PRODUCT}"/>`,
  `<meta content="${PRODUCT}" property="og:site_name"/>`,
  `<meta data-x="1" property="og:site_name" content="${PRODUCT}" data-y="2">`,
  String.raw`[\"$\",\"meta\",null,{\"property\":\"og:site_name\",\"content\":\"Strata Sync\"}]`,
  String.raw`[\"$\",\"meta\",null,{\"content\":\"Strata Sync\",\"property\":\"og:site_name\"}]`,
];

for (const html of OG_SITE_NAME_CASES) {
  const out = rewriteDocsBody(html);
  assert.equal(out.includes(PRODUCT), false, `old value survived: ${html}`);
  assert.equal(out.includes(HOST_SITE_NAME), true, html);
  assert.match(out, /og:site_name/, `tag lost entirely: ${html}`);
}

// Rule 8 before Rule 9: og:site_name may only become the person while og:title
// still names the product, or the card ends up identifying nothing.
const titleHtml = `<meta property="og:title" content="Introduction · ${PRODUCT}"/>`;
assert.equal(rewriteDocsBody(titleHtml), titleHtml);

if (process.env.SMOKE_LIVE) {
  const live = await fetch(UPSTREAM_DOCS_URL).then((response) =>
    response.text()
  );
  const upstreamName = live.match(
    /property="og:site_name"[^>]*content="([^"]*)"/u
  )?.[1];
  assert.ok(upstreamName, "upstream served no og:site_name to rewrite");

  const out = rewriteDocsBody(live);
  assert.match(out, /og:site_name/, "og:site_name lost from live HTML");
  assert.equal(
    out.includes(`content="${upstreamName}"`) &&
      upstreamName !== HOST_SITE_NAME,
    false,
    `upstream og:site_name "${upstreamName}" survived the rewrite`
  );
  assert.match(
    out,
    new RegExp(`property="og:title" content="[^"]*${PRODUCT}[^"]*"`, "u"),
    "og:title stopped naming the product, so the card names nothing"
  );
  process.stdout.write(
    `live upstream og:site_name "${upstreamName}" rewritten\n`
  );
}

process.stdout.write("docs-proxy smoke ok\n");
