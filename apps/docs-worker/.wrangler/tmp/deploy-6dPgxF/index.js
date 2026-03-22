// src/index.ts
var index_default = {
  async fetch(request, env) {
    try {
      const docsUrl = env?.DOCS_URL ?? "docs.stratasync.dev";
      const customUrl = env?.CUSTOM_URL ?? "stratasync.dev";
      const landingHost = env?.LANDING_URL ?? "landing.stratasync.dev";
      const urlObject = new URL(request.url);
      if (urlObject.pathname.startsWith("/.well-known/")) {
        return await fetch(request);
      }
      if (urlObject.hostname === `docs.${customUrl}`) {
        const redirectUrl = new URL(urlObject.pathname, `https://${customUrl}`);
        redirectUrl.pathname = `/docs${urlObject.pathname === "/" ? "" : urlObject.pathname}`;
        redirectUrl.search = urlObject.search;
        return Response.redirect(redirectUrl.toString(), 301);
      }
      if (urlObject.pathname === "/opengraph-image.png") {
        const landingUrl2 = new URL(request.url);
        landingUrl2.hostname = landingHost;
        return await fetch(landingUrl2, {
          headers: request.headers,
          method: request.method
        });
      }
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
      const landingUrl = new URL(request.url);
      landingUrl.hostname = landingHost;
      return await fetch(landingUrl, {
        body: request.body,
        headers: request.headers,
        method: request.method
      });
    } catch {
      return await fetch(request);
    }
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
