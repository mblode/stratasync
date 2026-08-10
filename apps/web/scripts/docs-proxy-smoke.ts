/**
 * Guards the docs proxy after `og:site_name` moved to docs.json.
 *
 * `seo.siteName` / `metadata.ogImage` in `apps/docs/docs.json` own the card
 * credit and image. The proxy must pass `og:site_name` through unchanged and
 * still inject `twitter:creator`.
 *
 *   npm run smoke:docs-proxy               # fixtures only, no network
 *   SMOKE_LIVE=1 npm run smoke:docs-proxy  # also checks the real upstream
 */

import assert from "node:assert/strict";

import { rewriteDocsBody } from "../lib/docs-proxy.ts";

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
  assert.equal(out, html, `og:site_name was rewritten: ${html}`);
}

const titleHtml = `<meta property="og:title" content="Introduction · ${PRODUCT}"/>`;
assert.equal(rewriteDocsBody(titleHtml), titleHtml);

// twitter:creator is absent upstream, so it is added rather than rewritten.
const HEAD_ONLY = "<html><head><title>x</title></head><body></body></html>";
const withCreator = rewriteDocsBody(HEAD_ONLY);
assert.match(
  withCreator,
  /<meta name="twitter:creator" content="@mattblode"\/>/
);
assert.equal(
  (withCreator.match(/twitter:creator/g) ?? []).length,
  1,
  "injected twice"
);
// Already present upstream: left alone rather than duplicated.
const ALREADY =
  '<html><head><meta name="twitter:creator" content="@mattblode"/></head></html>';
assert.equal(
  (rewriteDocsBody(ALREADY).match(/twitter:creator/g) ?? []).length,
  1
);

if (process.env.SMOKE_LIVE) {
  const live = await fetch(UPSTREAM_DOCS_URL).then((response) =>
    response.text()
  );
  const upstreamName = live.match(
    /property="og:site_name"[^>]*content="([^"]*)"/u
  )?.[1];
  assert.ok(upstreamName, "upstream served no og:site_name");

  const out = rewriteDocsBody(live);
  const rewrittenName = out.match(
    /property="og:site_name"[^>]*content="([^"]*)"/u
  )?.[1];
  assert.equal(
    rewrittenName,
    upstreamName,
    `og:site_name was rewritten from "${upstreamName}" to "${rewrittenName}"`
  );
  assert.match(
    out,
    new RegExp(`property="og:title" content="[^"]*${PRODUCT}[^"]*"`, "u"),
    "og:title stopped naming the product, so the card names nothing"
  );
  assert.match(
    out,
    /<meta name="twitter:creator" content="@mattblode"\/>/u,
    "twitter:creator missing from live HTML"
  );
  process.stdout.write(
    `live upstream og:site_name "${upstreamName}" passed through\n`
  );
}

process.stdout.write("docs-proxy smoke ok\n");
