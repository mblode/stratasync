interface Env {
  DOCS_URL?: string;
  CUSTOM_URL?: string;
  LANDING_URL?: string;
}

const DOCS_PREFIX = "/docs";
const DOCS_PAGE_PATHS = [
  "/manifesto",
  "/values",
  "/mission",
  "/product-vision",
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

  const canonicalHosts = [`https://${docsUrl}`, `https://${customUrl}`];
  for (const host of canonicalHosts) {
    rewrittenHtml = rewrittenHtml.replaceAll(
      `rel="canonical" href="${host}"`,
      `rel="canonical" href="https://${customUrl}${DOCS_PREFIX}"`
    );
    rewrittenHtml = rewrittenHtml.replaceAll(
      `rel="canonical" href="${host}/"`,
      `rel="canonical" href="https://${customUrl}${DOCS_PREFIX}"`
    );

    for (const path of DOCS_PAGE_PATHS) {
      rewrittenHtml = rewrittenHtml.replaceAll(
        `rel="canonical" href="${host}${path}"`,
        `rel="canonical" href="https://${customUrl}${toDocsPath(path)}"`
      );
    }
  }

  return rewrittenHtml;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const docsUrl = env?.DOCS_URL ?? "stratasync.blode.md";
      const customUrl = env?.CUSTOM_URL ?? "stratasync.dev";
      const landingHost = env?.LANDING_URL ?? "landing.stratasync.dev";
      const urlObject = new URL(request.url);

      // Agent discovery endpoints are served by the landing app, so forward
      // them explicitly to the landing host. All other /.well-known/ paths
      // (Vercel/Let's Encrypt verification, etc.) pass through to origin.
      if (
        urlObject.pathname === "/.well-known/api-catalog" ||
        urlObject.pathname === "/.well-known/agent-skills/index.json"
      ) {
        const landingUrl = new URL(request.url);
        landingUrl.hostname = landingHost;
        return await fetch(landingUrl, {
          body: request.body,
          headers: request.headers,
          method: request.method,
        });
      }
      if (urlObject.pathname.startsWith("/.well-known/")) {
        return await fetch(request);
      }

      // Redirect docs.stratasync.dev → stratasync.dev/docs
      if (urlObject.hostname === `docs.${customUrl}`) {
        const redirectUrl = new URL(urlObject.pathname, `https://${customUrl}`);
        redirectUrl.pathname = `/docs${urlObject.pathname === "/" ? "" : urlObject.pathname}`;
        redirectUrl.search = urlObject.search;
        return Response.redirect(redirectUrl.toString(), 301);
      }

      const docsRedirectPath = getDocsRedirectPath(
        urlObject.pathname,
        request.headers.get("Referer")
      );
      if (docsRedirectPath) {
        const redirectUrl = new URL(request.url);
        redirectUrl.pathname = docsRedirectPath;
        redirectUrl.search = urlObject.search;
        return Response.redirect(redirectUrl.toString(), 308);
      }

      // Proxy OpenGraph image requests to landing page
      if (urlObject.pathname === "/opengraph-image.png") {
        const landingUrl = new URL(request.url);
        landingUrl.hostname = landingHost;
        return await fetch(landingUrl, {
          headers: request.headers,
          method: request.method,
        });
      }

      // Proxy requests to /docs path to Blode docs
      if (
        isDocsPath(urlObject.pathname) ||
        shouldProxyAssetToDocs(
          urlObject.pathname,
          request.headers.get("Referer")
        )
      ) {
        const url = new URL(request.url);
        url.hostname = docsUrl;

        const proxyRequest = new Request(url, request);
        proxyRequest.headers.set("Host", docsUrl);
        proxyRequest.headers.set("X-Forwarded-Host", customUrl);
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
            docsUrl,
            customUrl
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
        if (!contentType.includes("text/html")) {
          return docsResponse;
        }

        const rewrittenHtml = rewriteDocsHtml(
          await docsResponse.text(),
          customUrl,
          docsUrl
        );
        return new Response(rewrittenHtml, {
          headers: docsResponse.headers,
          status: docsResponse.status,
          statusText: docsResponse.statusText,
        });
      }

      // Route all other traffic to landing page
      const landingUrl = new URL(request.url);
      landingUrl.hostname = landingHost;
      return await fetch(landingUrl, {
        body: request.body,
        headers: request.headers,
        method: request.method,
      });
    } catch {
      return await fetch(request);
    }
  },
};
