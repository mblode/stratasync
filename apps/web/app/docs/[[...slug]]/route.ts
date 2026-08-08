import {
  docsUpstreamUrl,
  filterUpstreamRequestHeaders,
  filterUpstreamResponseHeaders,
  rewriteDocsBody,
  shouldRewriteDocsBody,
} from "@/lib/docs-proxy";

interface RouteContext {
  params: Promise<{ slug?: string[] }>;
}

const proxyDocs = async (request: Request, context: RouteContext) => {
  const { slug } = await context.params;
  const requestUrl = new URL(request.url);
  const upstreamUrl = docsUpstreamUrl(slug, requestUrl.search);

  const upstream = await fetch(upstreamUrl, {
    headers: filterUpstreamRequestHeaders(request.headers),
    method: request.method,
    redirect: "manual",
  });

  const responseHeaders = filterUpstreamResponseHeaders(
    upstream.headers,
    requestUrl
  );
  const contentType = upstream.headers.get("content-type") ?? "";

  if (request.method === "HEAD" || !shouldRewriteDocsBody(contentType)) {
    return new Response(upstream.body, {
      headers: responseHeaders,
      status: upstream.status,
      statusText: upstream.statusText,
    });
  }

  const rewritten = rewriteDocsBody(await upstream.text());
  return new Response(rewritten, {
    headers: responseHeaders,
    status: upstream.status,
    statusText: upstream.statusText,
  });
};

export const GET = proxyDocs;
export const HEAD = proxyDocs;
