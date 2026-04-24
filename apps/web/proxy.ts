import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Markdown content negotiation for AI agents. Requests to `/` with an
// `Accept: text/markdown` preference are rewritten to a route that returns
// the homepage as markdown with `Content-Type: text/markdown`. Browsers and
// other clients continue to receive the default HTML response.

const MARKDOWN_DESTINATION = "/well-known/home-markdown";

const prefersMarkdown = (accept: string | null): boolean => {
  if (!accept) {
    return false;
  }

  const entries = accept.split(",").map((entry) => {
    const [type, ...params] = entry
      .trim()
      .split(";")
      .map((s) => s.trim());
    const qParam = params.find((p) => p.startsWith("q="));
    const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1;
    return { q: Number.isFinite(q) ? q : 0, type: type.toLowerCase() };
  });

  const markdown = entries.find((e) => e.type === "text/markdown");
  if (!markdown || markdown.q === 0) {
    return false;
  }

  const html = entries.find(
    (e) => e.type === "text/html" || e.type === "application/xhtml+xml"
  );
  return !html || markdown.q >= html.q;
};

export const proxy = (request: NextRequest) => {
  if (prefersMarkdown(request.headers.get("accept"))) {
    const url = request.nextUrl.clone();
    url.pathname = MARKDOWN_DESTINATION;
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
};

export const config = {
  matcher: "/",
};
