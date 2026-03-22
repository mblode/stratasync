import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const wantsMarkdown = (request: NextRequest): boolean => {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/markdown");
};

export const proxy = (request: NextRequest) => {
  if (!wantsMarkdown(request)) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = `${url.pathname}.mdx`;
  return NextResponse.rewrite(url);
};

export const config = {
  matcher: ["/((?!_next|api|llms\\.txt|llms-full\\.txt|.*\\.mdx$|.*\\.).*)"],
};
