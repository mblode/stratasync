interface Env {
  DOCS_URL?: string;
  CUSTOM_URL?: string;
  LANDING_URL?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const docsUrl = env?.DOCS_URL ?? "docs.stratasync.dev";
      const customUrl = env?.CUSTOM_URL ?? "stratasync.dev";
      const landingHost = env?.LANDING_URL ?? "landing.stratasync.dev";
      const urlObject = new URL(request.url);

      // Allow Vercel/Let's Encrypt verification paths to pass through
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

      // Proxy OpenGraph image requests to landing page
      if (urlObject.pathname === "/opengraph-image.png") {
        const landingUrl = new URL(request.url);
        landingUrl.hostname = landingHost;
        return await fetch(landingUrl, {
          headers: request.headers,
          method: request.method,
        });
      }

      // Proxy requests to /docs path to Fumadocs
      if (urlObject.pathname.startsWith("/docs")) {
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

        return await fetch(proxyRequest);
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
