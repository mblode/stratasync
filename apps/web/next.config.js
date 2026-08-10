import { readFileSync } from "node:fs";

const { version } = JSON.parse(
  readFileSync(
    new URL("../../packages/core/package.json", import.meta.url),
    "utf8"
  )
);

// Analytics is proxied through r.blode.co so tracker blockers do not drop it.
// Defaulted rather than left empty: an unset var would compile down to
// `connect-src 'self'`, which is how this policy blocked PostHog outright —
// `instrumentation-client.ts` has been initialising a client that could never
// reach its host, on every docs page, since this CSP shipped.
const posthogOrigin =
  process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://r.blode.co";

/** @type {import('next').NextConfig} */
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""} https://www.googletagmanager.com ${posthogOrigin}`,
  `connect-src 'self' https://www.google-analytics.com https://www.googletagmanager.com ${posthogOrigin}`,
  "img-src 'self' data: https://www.google-analytics.com https://images.unsplash.com",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

const ZONE = "/stratasync";

// RFC 8288 Link headers for agent discovery.
// - api-catalog: RFC 9727 machine-readable index of API resources
// - service-doc: IANA-registered rel for human-readable API docs
// - alternate (text/markdown): advertises markdown content negotiation
// Paths are absolute from the public origin so they resolve under the zone
// rewrite (and under the zone host with basePath).
const agentDiscoveryLinkHeader = [
  `<${ZONE}/.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"`,
  `<${ZONE}/docs>; rel="service-doc"; type="text/html"; title="Strata Sync Documentation"`,
  `<${ZONE}/.well-known/agent-skills/index.json>; rel="https://agentskills.io/rel/index"; type="application/json"`,
  `<${ZONE}/>; rel="alternate"; type="text/markdown"`,
].join(", ");

const agentDiscoveryHeaders = [
  { key: "Link", value: agentDiscoveryLinkHeader },
  { key: "Vary", value: "Accept" },
];

/** An override that sets only the one key it changes; see `headers()` below. */
const crossOriginResourcePolicy = (value) => [
  { key: "Cross-Origin-Resource-Policy", value },
];

const nextConfig = {
  // blode.co proxies /stratasync to this deployment, so every route and asset
  // has to live under that prefix (beautiful-qr-code / moon gold standard).
  assetPrefix: ZONE,
  basePath: ZONE,
  env: {
    STRATASYNC_VERSION: version,
  },
  experimental: {
    // Enable filesystem caching for `next build`
    turbopackFileSystemCacheForBuild: true,
    // Enable filesystem caching for `next dev`
    turbopackFileSystemCacheForDev: true,
  },
  headers() {
    /*
     * Every matching rule applies in array order and a later one wins per
     * header key, so the catch-all goes FIRST and the overrides after it.
     *
     * It used to be last, and that silently undid all five overrides below:
     * blode.co/stratasync/opengraph-image.png served `Cross-Origin-Resource-
     * Policy: same-origin` rather than the `cross-origin` this file asks for,
     * so no off-site consumer could fetch the share card. Nothing failed a
     * build and the config still read as if it worked.
     *
     * The pattern is also `/:path*` rather than `/(.*)`: with `basePath` set
     * Next prefixes the source, and `/stratasync/(.*)` does not match the bare
     * `/stratasync`. The zone root — the most-visited URL here — was shipping
     * no security headers at all while every inner page carried the full set.
     * blode.co/allmd has the same miss from the same pattern.
     *
     * Each override now sets only the key it is changing and lets the
     * catch-all supply the rest.
     */
    return [
      {
        headers: securityHeaders,
        source: "/:path*",
      },
      {
        headers: crossOriginResourcePolicy("cross-origin"),
        source: "/opengraph-image.png",
      },
      {
        headers: crossOriginResourcePolicy("cross-origin"),
        source: "/twitter-image.png",
      },
      {
        headers: crossOriginResourcePolicy("cross-origin"),
        source: "/web-app-manifest-:size.png",
      },
      {
        headers: crossOriginResourcePolicy("same-site"),
        source: "/images/:path*",
      },
      {
        headers: crossOriginResourcePolicy("same-site"),
        source: "/fonts/:path*",
      },
      {
        headers: agentDiscoveryHeaders,
        source: "/",
      },
    ];
  },
  images: {
    remotePatterns: [
      {
        hostname: "images.unsplash.com",
        protocol: "https",
      },
    ],
  },
  redirects() {
    const apexHosts = ["stratasync.dev", "www.stratasync.dev"];
    const apexRedirects = apexHosts.flatMap((host) => {
      const has = [{ type: "host", value: host }];
      return [
        {
          basePath: false,
          destination: "https://blode.co/stratasync",
          has,
          permanent: true,
          source: "/stratasync",
        },
        {
          basePath: false,
          destination: "https://blode.co/stratasync/:path*",
          has,
          permanent: true,
          source: "/stratasync/:path*",
        },
        {
          basePath: false,
          destination: "https://blode.co/stratasync",
          has,
          permanent: true,
          source: "/",
        },
        {
          basePath: false,
          destination: "https://blode.co/stratasync/:path*",
          has,
          permanent: true,
          source: "/:path*",
        },
      ];
    });

    return apexRedirects;
  },
  rewrites() {
    return {
      afterFiles: [
        {
          destination: "/well-known/api-catalog",
          source: "/.well-known/api-catalog",
        },
        {
          destination: "/well-known/agent-skills-index",
          source: "/.well-known/agent-skills/index.json",
        },
      ],
      beforeFiles: [
        // basePath:false — an external destination must not get /stratasync
        // prefixed (that 404s on the docs host). HTML is proxied by
        // app/docs/[[...slug]]/route.ts and rewrites asset URLs onto this path.
        {
          basePath: false,
          destination: "https://stratasync.blode.md/_docs/:path*",
          source: `${ZONE}/_docs/:path*`,
        },
      ],
    };
  },
};

export default nextConfig;
