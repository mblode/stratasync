import type { MetadataRoute } from "next";

import { siteConfig } from "@/lib/config";

const robots = (): MetadataRoute.Robots => ({
  rules: {
    allow: "/",
    userAgent: "*",
  },
  // Zone robots.txt is inert on blode.co (only the host root is read). Kept
  // accurate for the zone origin and preview. Docs sitemap stays on the custom
  // domain until the docs worker is zone-ified.
  sitemap: [
    `${siteConfig.url}/sitemap.xml`,
    "https://stratasync.dev/docs/sitemap.xml",
  ],
});

export default robots;
