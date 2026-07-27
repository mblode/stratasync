import type { MetadataRoute } from "next";

import { siteConfig } from "@/lib/config";

const robots = (): MetadataRoute.Robots => ({
  rules: {
    allow: "/",
    userAgent: "*",
  },
  // /docs is served by a separate docs platform that publishes its own
  // sitemap, proxied onto this domain by the docs worker.
  sitemap: [
    `${siteConfig.url}/sitemap.xml`,
    `${siteConfig.url}/docs/sitemap.xml`,
  ],
});

export default robots;
