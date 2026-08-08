import { readFileSync } from "node:fs";

const { version } = JSON.parse(
  readFileSync(
    new URL("../../packages/core/package.json", import.meta.url),
    "utf8"
  )
);

/** @type {import('next').NextConfig} */
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""} https://www.googletagmanager.com`,
  "connect-src 'self' https://www.google-analytics.com https://www.googletagmanager.com",
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
// rewrite (and under the zone host with basePath). Docs stay on the custom
// domain until the docs worker is zone-ified.
const agentDiscoveryLinkHeader = [
  `<${ZONE}/.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"`,
  '<https://stratasync.dev/docs>; rel="service-doc"; type="text/html"; title="Strata Sync Documentation"',
  `<${ZONE}/.well-known/agent-skills/index.json>; rel="https://agentskills.io/rel/index"; type="application/json"`,
  `<${ZONE}/>; rel="alternate"; type="text/markdown"`,
].join(", ");

const agentDiscoveryHeaders = [
  { key: "Link", value: agentDiscoveryLinkHeader },
  { key: "Vary", value: "Accept" },
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
    return [
      {
        headers: [
          ...securityHeaders.filter(
            (h) => h.key !== "Cross-Origin-Resource-Policy"
          ),
          { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
        ],
        source: "/opengraph-image.png",
      },
      {
        headers: [
          ...securityHeaders.filter(
            (h) => h.key !== "Cross-Origin-Resource-Policy"
          ),
          { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
        ],
        source: "/twitter-image.png",
      },
      {
        headers: [
          ...securityHeaders.filter(
            (h) => h.key !== "Cross-Origin-Resource-Policy"
          ),
          { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
        ],
        source: "/web-app-manifest-:size.png",
      },
      {
        headers: [
          ...securityHeaders.filter(
            (h) => h.key !== "Cross-Origin-Resource-Policy"
          ),
          { key: "Cross-Origin-Resource-Policy", value: "same-site" },
        ],
        source: "/images/:path*",
      },
      {
        headers: [
          ...securityHeaders.filter(
            (h) => h.key !== "Cross-Origin-Resource-Policy"
          ),
          { key: "Cross-Origin-Resource-Policy", value: "same-site" },
        ],
        source: "/fonts/:path*",
      },
      {
        headers: agentDiscoveryHeaders,
        source: "/",
      },
      {
        headers: securityHeaders,
        source: "/(.*)",
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
    return apexHosts.flatMap((host) => {
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
  },
  rewrites() {
    return [
      {
        destination: "/well-known/api-catalog",
        source: "/.well-known/api-catalog",
      },
      {
        destination: "/well-known/agent-skills-index",
        source: "/.well-known/agent-skills/index.json",
      },
    ];
  },
};

export default nextConfig;
