import { siteConfig } from "@/lib/config";

// RFC 9727 API Catalog: machine-readable index advertising the service's
// documentation and status endpoints. Served at /.well-known/api-catalog
// via a rewrite declared in next.config.js.

const CACHE_ONE_HOUR = "public, max-age=3600, stale-while-revalidate=86400";

const linkset = {
  linkset: [
    {
      anchor: siteConfig.url,
      "service-doc": [
        {
          href: `${siteConfig.url}/docs`,
          title: `${siteConfig.name} Documentation`,
          type: "text/html",
        },
      ],
      "service-meta": [
        {
          href: `${siteConfig.url}/.well-known/agent-skills/index.json`,
          type: "application/json",
        },
      ],
      status: [
        {
          href: siteConfig.url,
          type: "text/html",
        },
      ],
    },
  ],
};

export const GET = () =>
  new Response(JSON.stringify(linkset, null, 2), {
    headers: {
      "Cache-Control": CACHE_ONE_HOUR,
      "Content-Type": "application/linkset+json",
    },
  });
