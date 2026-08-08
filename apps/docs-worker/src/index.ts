interface Env {
  CUSTOM_URL?: string;
  DOCS_URL?: string;
  ZONE_ORIGIN?: string;
}

const DOCS_PREFIX = "/docs";
const DOCS_ASSET_PREFIX = "/_docs";

const DEFAULT_CUSTOM_URL = "stratasync.dev";
const DEFAULT_DOCS_URL = "stratasync.blode.md";
const DEFAULT_ZONE_ORIGIN = "https://blode.co/stratasync";

const getWorkerConfig = (env: Env) => ({
  customUrl: env.CUSTOM_URL ?? DEFAULT_CUSTOM_URL,
  docsUrl: env.DOCS_URL ?? DEFAULT_DOCS_URL,
  zoneOrigin: env.ZONE_ORIGIN ?? DEFAULT_ZONE_ORIGIN,
});

const redirect = (location: string): Response =>
  Response.redirect(location, 301);

const toZoneUrl = (
  zoneOrigin: string,
  pathname: string,
  search: string
): string => {
  const path = pathname === "/" ? "" : pathname;
  return `${zoneOrigin}${path}${search}`;
};

/**
 * Pure redirect worker for stratasync.dev → blode.co/stratasync (GSC change of address).
 *
 * No HTML/asset proxying. The old proxy rewrote docs onto /_docs paths; browsers
 * then followed apex /_docs/* → blode.co/stratasync/_docs/* (404 + CORP block).
 * Every path now 301s to the blode.co zone; the Next app forwards /docs to the
 * real docs host (stratasync.blode.md).
 */
const routeRequest = (request: Request, env: Env): Response => {
  const { customUrl, docsUrl, zoneOrigin } = getWorkerConfig(env);
  const url = new URL(request.url);

  // Legacy docs subdomain → real docs host (path under /docs).
  if (url.hostname === `docs.${customUrl}`) {
    const docsPath =
      url.pathname === "/" ? DOCS_PREFIX : `${DOCS_PREFIX}${url.pathname}`;
    return redirect(`https://${docsUrl}${docsPath}${url.search}`);
  }

  // Orphan /_next/* from the retired docs proxy → docs-host assets.
  if (url.pathname.startsWith("/_next/")) {
    return redirect(
      `https://${docsUrl}${DOCS_ASSET_PREFIX}${url.pathname}${url.search}`
    );
  }

  // Homepage, marketing, /docs, /_docs, .well-known — all to the blode.co zone.
  // Path-preserving so GSC change-of-address sample URLs land on blode.co.
  return redirect(toZoneUrl(zoneOrigin, url.pathname, url.search));
};

export default {
  fetch(request: Request, env: Env): Response {
    try {
      return routeRequest(request, env);
    } catch {
      return redirect(env.ZONE_ORIGIN ?? DEFAULT_ZONE_ORIGIN);
    }
  },
};
