import type { MetadataRoute } from "next";

import { siteConfig } from "@/lib/config";

const sitemap = (): MetadataRoute.Sitemap => [
  {
    changeFrequency: "weekly",
    lastModified: new Date(),
    priority: 1,
    url: siteConfig.url,
  },
  {
    changeFrequency: "weekly",
    lastModified: new Date(),
    priority: 0.8,
    url: `${siteConfig.url}/docs`,
  },
];

export default sitemap;
