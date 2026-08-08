import type { MetadataRoute } from "next";

import { siteConfig } from "@/lib/config";

const robots = (): MetadataRoute.Robots => ({
  rules: {
    allow: "/",
    userAgent: "*",
  },
  // Zone robots.txt is inert on blode.co (only the host root is read). Kept
  // accurate for the zone origin and preview.
  sitemap: [`${siteConfig.url}/sitemap.xml`],
});

export default robots;
