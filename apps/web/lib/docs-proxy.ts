const ZONE = "/stratasync";
const DOCS_PREFIX = "/docs";
const DOCS_ASSET_PREFIX = "/_docs";
const DOCS_HOST = "stratasync.blode.md";
const PUBLIC_ORIGIN = "https://blode.co";

const REGEXP_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;
const URL_TERMINATOR_CHARS = "\"'\\\\\\s<>";

const escapeRegExp = (value: string): string =>
  value.replace(REGEXP_SPECIAL_CHARS, "\\$&");

const REWRITABLE_CONTENT_TYPES = [
  "text/html",
  "text/markdown",
  "text/plain",
  "text/x-component",
  "application/json",
  "xml",
] as const;

const DOCS_HOST_ORIGINS = [`https://${DOCS_HOST}`] as const;
const LEGACY_SITE_ORIGINS = [
  "https://stratasync.dev",
  "http://stratasync.dev",
] as const;

export const shouldRewriteDocsBody = (contentType: string): boolean =>
  REWRITABLE_CONTENT_TYPES.some((type) => contentType.includes(type));

/** Map a docs-host pathname onto the blode.co zone (/docs stays under /docs). */
export const toZoneDocsPath = (pathname: string): string => {
  if (
    pathname === DOCS_PREFIX ||
    pathname.startsWith(`${DOCS_PREFIX}/`) ||
    pathname === DOCS_ASSET_PREFIX ||
    pathname.startsWith(`${DOCS_ASSET_PREFIX}/`)
  ) {
    return `${ZONE}${pathname}`;
  }

  if (pathname === "/" || pathname === "") {
    return `${ZONE}${DOCS_PREFIX}`;
  }

  return `${ZONE}${DOCS_PREFIX}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
};

/** Map a legacy marketing-host pathname onto the blode.co zone. */
export const toZoneSitePath = (pathname: string): string => {
  if (pathname === "/" || pathname === "") {
    return ZONE;
  }
  if (
    pathname === DOCS_PREFIX ||
    pathname.startsWith(`${DOCS_PREFIX}/`) ||
    pathname === DOCS_ASSET_PREFIX ||
    pathname.startsWith(`${DOCS_ASSET_PREFIX}/`)
  ) {
    return `${ZONE}${pathname}`;
  }
  return `${ZONE}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
};

export const docsUpstreamUrl = (
  slug: string[] | undefined,
  search: string
): URL => {
  const suffix = slug?.length ? `/${slug.join("/")}` : "";
  return new URL(`https://${DOCS_HOST}${DOCS_PREFIX}${suffix}${search}`);
};

const rewriteOriginUrls = (
  body: string,
  origins: readonly string[],
  toPath: (pathname: string) => string
): string => {
  let rewritten = body;

  for (const origin of origins) {
    const pattern = new RegExp(
      `${escapeRegExp(origin)}([^${URL_TERMINATOR_CHARS}]*)`,
      "g"
    );
    rewritten = rewritten.replace(pattern, (_match, path: string) => {
      const pathname = path === "" ? "/" : (path.split("?")[0] ?? "/");
      const query = path.includes("?") ? path.slice(path.indexOf("?")) : "";
      return `${PUBLIC_ORIGIN}${toPath(pathname)}${query}`;
    });
  }

  return rewritten;
};

const rewriteAbsoluteDocsUrls = (body: string): string =>
  rewriteOriginUrls(
    rewriteOriginUrls(body, DOCS_HOST_ORIGINS, toZoneDocsPath),
    LEGACY_SITE_ORIGINS,
    toZoneSitePath
  );

const rewriteRootRelativeDocsPaths = (body: string): string =>
  body
    .replaceAll(/(?<!\/stratasync)\/_docs\//g, `${ZONE}/_docs/`)
    .replaceAll(/(?<!\/stratasync)\/docs\//g, `${ZONE}/docs/`)
    .replaceAll(/(?<!\/stratasync)\/docs"/g, `${ZONE}/docs"`)
    .replaceAll(/(?<!\/stratasync)\/docs'/g, `${ZONE}/docs'`)
    .replaceAll('href="/llms.txt"', `href="${ZONE}/docs/llms.txt"`)
    .replaceAll('href="/llms-full.txt"', `href="${ZONE}/docs/llms-full.txt"`);

/**
 * The docs are a blode.md tenant, and its `docs.json` `name` drives both the
 * title suffix and `og:site_name`. Behind this rewrite these pages are blode.co
 * paths, so Rule 9 wants the person in `og:site_name`: the product is already
 * in `og:title` ("Introduction · Strata Sync"), and repeating it there spends
 * the one slot in the card that could say who made the thing.
 *
 * Rewritten here rather than in `docs.json` because `name` feeds the title too.
 * Setting it to "Matthew Blode" would make every docs page read "Introduction ·
 * Matthew Blode" and leave nothing on the card naming the product, which is the
 * exact failure Rule 9's "Do Rule 8 first" section describes.
 *
 * This is a stopgap. The real home is a `seo.siteName` in blode.md, which would
 * fix every tenant at once; the schema at https://blode.md/docs.json has no
 * such key today, and `allmd`, `diffhub`, `dnd-grid` and `react-vello` all
 * serve their product name here for the same reason.
 *
 * Both copies are replaced: the rendered `<meta>`, and the one React
 * re-renders from the flight payload on hydration.
 */
export const HOST_SITE_NAME = "Matthew Blode";

/**
 * Matched on `og:site_name` alone, then the `content` attribute is replaced
 * inside whatever matched. An earlier version required `property` before
 * `content` in one pattern: if the platform ever emits them the other way the
 * regex matches nothing, rewrites nothing, and the old value ships while any
 * assertion phrased as "the new value is present" still passes.
 */
const OG_SITE_NAME_META = /<meta\b[^>]*\bproperty="og:site_name"[^>]*>/giu;
const META_CONTENT_ATTR = /\bcontent="[^"]*"/iu;
const OG_SITE_NAME_FLIGHT = /\{[^{}]*\\"og:site_name\\"[^{}]*\}/gu;
const FLIGHT_CONTENT_ATTR = /\\"content\\":\\"[^"\\]*\\"/u;

export const rewriteOgSiteName = (body: string): string =>
  body
    .replace(OG_SITE_NAME_META, (tag) =>
      tag.replace(META_CONTENT_ATTR, `content="${HOST_SITE_NAME}"`)
    )
    .replace(OG_SITE_NAME_FLIGHT, (node) =>
      node.replace(FLIGHT_CONTENT_ATTR, `\\"content\\":\\"${HOST_SITE_NAME}\\"`)
    );

/**
 * `twitter:creator` is absent from the upstream entirely: blode.md has no field
 * for it, so unlike `og:site_name` there is nothing to rewrite and the tag has
 * to be added. Rule 10 wants person-level attribution on every blode.co path,
 * and these are blode.co paths.
 *
 * Inserted into `<head>` only, not into the flight payload. Social crawlers do
 * not run JavaScript, so the served HTML is what builds the card; React may
 * drop the tag on hydration since it is not in the payload it renders from.
 * Adding it there too would mean hand-forging a serialized React element, which
 * is far more likely to break the page than to help it. The upstream `seo`
 * config is the real fix.
 */
const TWITTER_CREATOR = "@mattblode";
const TWITTER_CREATOR_META = /<meta[^>]*name="twitter:creator"[^>]*>/iu;
const HEAD_OPEN = /<head\b[^>]*>/iu;

export const ensureTwitterCreator = (body: string): string => {
  if (TWITTER_CREATOR_META.test(body)) {
    return body;
  }
  return body.replace(
    HEAD_OPEN,
    (tag) => `${tag}<meta name="twitter:creator" content="${TWITTER_CREATOR}"/>`
  );
};

export const rewriteDocsBody = (body: string): string =>
  ensureTwitterCreator(
    rewriteOgSiteName(
      rewriteRootRelativeDocsPaths(rewriteAbsoluteDocsUrls(body))
    )
  );

export const rewriteDocsLocation = (
  location: string,
  requestUrl: URL
): string | null => {
  let resolved: URL;
  try {
    resolved = new URL(location, requestUrl);
  } catch {
    return null;
  }

  const isDocsHost =
    resolved.hostname === DOCS_HOST ||
    resolved.hostname === requestUrl.hostname ||
    resolved.hostname === "stratasync.dev";

  if (!isDocsHost) {
    return null;
  }

  return `${PUBLIC_ORIGIN}${toZoneDocsPath(resolved.pathname)}${resolved.search}`;
};

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
]);

export const filterUpstreamRequestHeaders = (headers: Headers): Headers => {
  const out = new Headers();
  // Only forward headers the docs host needs. Do not send X-Forwarded-Host /
  // Host overrides — Blode.md tenancy keys off the request host, and spoofing
  // blode.co makes the upstream resolve no tenant (404).
  const allow = new Set([
    "accept",
    "accept-language",
    "rsc",
    "next-router-state-tree",
    "next-router-prefetch",
    "next-router-segment-prefetch",
    "next-url",
    "user-agent",
  ]);
  for (const [key, value] of headers.entries()) {
    if (allow.has(key.toLowerCase())) {
      out.set(key, value);
    }
  }
  return out;
};

export const filterUpstreamResponseHeaders = (
  headers: Headers,
  requestUrl: URL
): Headers => {
  const out = new Headers();
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) {
      continue;
    }
    if (lower === "location") {
      out.set(key, rewriteDocsLocation(value, requestUrl) ?? value);
      continue;
    }
    if (lower === "link") {
      out.set(key, rewriteDocsBody(value));
      continue;
    }
    out.set(key, value);
  }
  return out;
};
