interface Env {
  DOCS_URL?: string;
  CUSTOM_URL?: string;
}

interface WorkerConfig {
  customUrl: string;
  docsUrl: string;
}

const DOCS_PREFIX = "/docs";
const DOCS_PAGE_PATHS = [
  "/installation",
  "/quick-start",
  "/architecture",
  "/architecture/sync-protocol",
  "/architecture/data-flow",
  "/guides/offline-first",
  "/guides/collaborative-editing",
  "/guides/conflict-resolution",
  "/guides/ssr-bootstrap",
  "/guides/model-relationships",
  "/guides/load-strategies",
  "/packages",
  "/packages/core",
  "/packages/client",
  "/packages/react",
  "/packages/next",
  "/packages/y-doc",
  "/packages/mobx",
  "/packages/storage-idb",
  "/packages/transport-graphql",
] as const;
const DOCS_PAGE_PATH_SET = new Set<string>(DOCS_PAGE_PATHS);
const DOCS_SECTION_PREFIXES = [
  "/architecture",
  "/guides",
  "/packages",
] as const;

const isDocsPath = (pathname: string): boolean =>
  pathname === DOCS_PREFIX || pathname.startsWith(`${DOCS_PREFIX}/`);

const isNextInternalPath = (pathname: string): boolean =>
  pathname.startsWith("/_next/");

const toDocsPath = (pathname: string): string => {
  if (isDocsPath(pathname)) {
    return pathname;
  }

  return pathname === "/" ? DOCS_PREFIX : `${DOCS_PREFIX}${pathname}`;
};

const isKnownDocsPagePath = (pathname: string): boolean => {
  const normalizedPath = pathname.endsWith(".mdx")
    ? pathname.slice(0, -".mdx".length)
    : pathname;

  if (DOCS_PAGE_PATH_SET.has(normalizedPath)) {
    return true;
  }

  return DOCS_SECTION_PREFIXES.some(
    (prefix) =>
      normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  );
};

const getDocsRedirectPath = (
  pathname: string,
  referer: string | null
): string | null => {
  if (pathname === "/") {
    if (!referer) {
      return null;
    }

    try {
      return isDocsPath(new URL(referer).pathname) ? DOCS_PREFIX : null;
    } catch {
      return null;
    }
  }

  return isKnownDocsPagePath(pathname) ? toDocsPath(pathname) : null;
};

const shouldProxyAssetToDocs = (
  pathname: string,
  referer: string | null
): boolean => {
  if (!isNextInternalPath(pathname) || !referer) {
    return false;
  }

  try {
    return isDocsPath(new URL(referer).pathname);
  } catch {
    return false;
  }
};

const rewriteDocsLocation = (
  location: string,
  requestUrl: URL,
  docsUrl: string,
  customUrl: string
): string | null => {
  let resolvedLocation: URL;

  try {
    resolvedLocation = new URL(location, requestUrl);
  } catch {
    return null;
  }

  const isSameOriginRedirect =
    resolvedLocation.hostname === requestUrl.hostname ||
    resolvedLocation.hostname === customUrl ||
    resolvedLocation.hostname === docsUrl;

  if (!isSameOriginRedirect) {
    return null;
  }

  if (
    resolvedLocation.pathname !== "/" &&
    !isKnownDocsPagePath(resolvedLocation.pathname)
  ) {
    return null;
  }

  resolvedLocation.protocol = requestUrl.protocol;
  resolvedLocation.host = requestUrl.host;
  resolvedLocation.pathname = toDocsPath(resolvedLocation.pathname);
  return resolvedLocation.toString();
};

const REGEXP_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;
// Absolute URL up to the first character that can terminate one inside HTML
// attributes, JSON string literals, or escaped JSON payloads.
const URL_TERMINATOR_CHARS = "\"'\\\\\\s<>";

const escapeRegExp = (value: string): string =>
  value.replace(REGEXP_SPECIAL_CHARS, "\\$&");

// The docs platform emits absolute URLs on its own host (canonical, og:url,
// JSON-LD). Left alone they tell crawlers the docs live on the docs host, so
// every proxied page is treated as non-canonical on the custom domain.
const rewriteDocsAbsoluteUrls = (
  html: string,
  customUrl: string,
  docsUrl: string
): string => {
  const pattern = new RegExp(
    `https://${escapeRegExp(docsUrl)}([^${URL_TERMINATOR_CHARS}]*)`,
    "g"
  );

  return html.replace(pattern, (_match, path: string) => {
    const pathname = path === "" ? "/" : path;
    // The docs host only serves docs, so its root maps to the /docs prefix.
    const rewrittenPath =
      pathname === "/" || isDocsPath(pathname) || isKnownDocsPagePath(pathname)
        ? toDocsPath(pathname)
        : pathname;

    return `https://${customUrl}${rewrittenPath}`;
  });
};

const rewriteDocsHtml = (
  html: string,
  customUrl: string,
  docsUrl: string
): string => {
  let rewrittenHtml = html;
  const docsHrefPaths = ["/", ...DOCS_PAGE_PATHS];

  for (const path of docsHrefPaths) {
    const docsPath = toDocsPath(path);
    rewrittenHtml = rewrittenHtml.replaceAll(
      `href="${path}"`,
      `href="${docsPath}"`
    );
    rewrittenHtml = rewrittenHtml.replaceAll(
      `href\\":\\"${path}\\"`,
      `href\\":\\"${docsPath}\\"`
    );
    rewrittenHtml = rewrittenHtml.replaceAll(
      `"href":"${path}"`,
      `"href":"${docsPath}"`
    );
  }

  for (const path of DOCS_PAGE_PATHS) {
    const mdxPath = `${path}.mdx`;
    const docsMdxPath = toDocsPath(mdxPath);
    rewrittenHtml = rewrittenHtml.replaceAll(
      `contentUrl\\":\\"${mdxPath}\\"`,
      `contentUrl\\":\\"${docsMdxPath}\\"`
    );
    rewrittenHtml = rewrittenHtml.replaceAll(
      `"contentUrl":"${mdxPath}"`,
      `"contentUrl":"${docsMdxPath}"`
    );
  }

  rewrittenHtml = rewriteDocsAbsoluteUrls(rewrittenHtml, customUrl, docsUrl);

  // Canonicals already on the custom domain can still carry the unprefixed
  // docs path, so normalise those separately — a blanket host rewrite would
  // also catch legitimate landing-page links.
  const customHost = `https://${customUrl}`;
  for (const rootHref of [`${customHost}"`, `${customHost}/"`]) {
    rewrittenHtml = rewrittenHtml.replaceAll(
      `rel="canonical" href="${rootHref}`,
      `rel="canonical" href="${customHost}${DOCS_PREFIX}"`
    );
  }
  for (const path of DOCS_PAGE_PATHS) {
    rewrittenHtml = rewrittenHtml.replaceAll(
      `rel="canonical" href="${customHost}${path}"`,
      `rel="canonical" href="${customHost}${toDocsPath(path)}"`
    );
  }

  return rewrittenHtml;
};

// sitemap.xml, llms.txt and the .md alternates all carry absolute docs-host
// URLs that need the same treatment as HTML. Chunk assets are excluded so the
// worker never buffers a bundle just to scan it.
const REWRITABLE_DOCS_CONTENT_TYPES = [
  "text/html",
  "text/markdown",
  "text/plain",
  "xml",
] as const;

const shouldRewriteDocsBody = (contentType: string): boolean =>
  REWRITABLE_DOCS_CONTENT_TYPES.some((type) => contentType.includes(type));

const getWorkerConfig = (env: Env): WorkerConfig => ({
  customUrl: env?.CUSTOM_URL ?? "stratasync.dev",
  docsUrl: env?.DOCS_URL ?? "stratasync.blode.md",
});

const getWellKnownResponse = (
  request: Request,
  pathname: string
): Response | Promise<Response> | null => {
  // Agent discovery lives on the blode.co zone (basePath /stratasync).
  if (
    pathname === "/.well-known/api-catalog" ||
    pathname === "/.well-known/agent-skills/index.json"
  ) {
    return Response.redirect(
      `https://blode.co/stratasync${pathname}${new URL(request.url).search}`,
      301
    );
  }

  // Vercel/Let's Encrypt verification, etc.
  return pathname.startsWith("/.well-known/") ? fetch(request) : null;
};

const getDocsHostRedirectResponse = (
  urlObject: URL,
  customUrl: string
): Response | null => {
  if (urlObject.hostname !== `docs.${customUrl}`) {
    return null;
  }

  const redirectUrl = new URL(urlObject.pathname, `https://${customUrl}`);
  redirectUrl.pathname = `/docs${urlObject.pathname === "/" ? "" : urlObject.pathname}`;
  redirectUrl.search = urlObject.search;
  return Response.redirect(redirectUrl.toString(), 301);
};

const getDocsPathRedirectResponse = (
  request: Request,
  urlObject: URL,
  referer: string | null
): Response | null => {
  const docsRedirectPath = getDocsRedirectPath(urlObject.pathname, referer);
  if (!docsRedirectPath) {
    return null;
  }

  const redirectUrl = new URL(request.url);
  redirectUrl.pathname = docsRedirectPath;
  redirectUrl.search = urlObject.search;
  return Response.redirect(redirectUrl.toString(), 308);
};

const shouldRouteToDocs = (pathname: string, referer: string | null): boolean =>
  isDocsPath(pathname) || shouldProxyAssetToDocs(pathname, referer);

const proxyDocsRequest = async (
  request: Request,
  urlObject: URL,
  config: WorkerConfig
): Promise<Response> => {
  const url = new URL(request.url);
  url.hostname = config.docsUrl;

  const proxyRequest = new Request(url, request);
  proxyRequest.headers.set("Host", config.docsUrl);
  proxyRequest.headers.set("X-Forwarded-Host", config.customUrl);
  proxyRequest.headers.set("X-Forwarded-Proto", "https");

  const clientIP = request.headers.get("CF-Connecting-IP");
  if (clientIP) {
    proxyRequest.headers.set("CF-Connecting-IP", clientIP);
  }

  const docsResponse = await fetch(proxyRequest);
  const location = docsResponse.headers.get("Location");
  if (location) {
    const rewrittenLocation = rewriteDocsLocation(
      location,
      urlObject,
      config.docsUrl,
      config.customUrl
    );

    if (rewrittenLocation) {
      const headers = new Headers(docsResponse.headers);
      headers.set("Location", rewrittenLocation);
      return new Response(docsResponse.body, {
        headers,
        status: docsResponse.status,
        statusText: docsResponse.statusText,
      });
    }
  }

  const contentType = docsResponse.headers.get("content-type") ?? "";
  if (!shouldRewriteDocsBody(contentType)) {
    return docsResponse;
  }

  const rewrittenHtml = contentType.includes("text/html")
    ? rewriteDocsHtml(
        await docsResponse.text(),
        config.customUrl,
        config.docsUrl
      )
    : rewriteDocsAbsoluteUrls(
        await docsResponse.text(),
        config.customUrl,
        config.docsUrl
      );
  const headers = new Headers(docsResponse.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(rewrittenHtml, {
    headers,
    status: docsResponse.status,
    statusText: docsResponse.statusText,
  });
};

const routeRequest = (
  request: Request,
  env: Env
): Promise<Response> | Response => {
  const config = getWorkerConfig(env);
  const urlObject = new URL(request.url);
  const referer = request.headers.get("Referer");
  const wellKnownResponse = getWellKnownResponse(request, urlObject.pathname);
  if (wellKnownResponse) {
    return wellKnownResponse;
  }

  const docsHostRedirect = getDocsHostRedirectResponse(
    urlObject,
    config.customUrl
  );
  if (docsHostRedirect) {
    return docsHostRedirect;
  }

  const docsPathRedirect = getDocsPathRedirectResponse(
    request,
    urlObject,
    referer
  );
  if (docsPathRedirect) {
    return docsPathRedirect;
  }

  if (shouldRouteToDocs(urlObject.pathname, referer)) {
    return proxyDocsRequest(request, urlObject, config);
  }

  // Orphan /_next/* on the apex — prefer docs assets (marketing 301s away).
  if (
    isNextInternalPath(urlObject.pathname) &&
    (request.method === "GET" || request.method === "HEAD")
  ) {
    return proxyDocsRequest(request, urlObject, config);
  }

  // Apex marketing → blode.co/stratasync zone.
  const zonePath = urlObject.pathname === "/" ? "" : urlObject.pathname;
  const zoneUrl = `https://blode.co/stratasync${zonePath}${urlObject.search}`;
  return Response.redirect(zoneUrl, 301);
};

const handleFetch = async (request: Request, env: Env): Promise<Response> => {
  try {
    return await routeRequest(request, env);
  } catch {
    return fetch(request);
  }
};

export default {
  fetch: handleFetch,
};
