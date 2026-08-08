import type { MetadataRoute } from "next";

import { siteConfig } from "@/lib/config";

// Only list URLs this zone owns. /docs is still served by the docs worker on
// stratasync.dev and has its own sitemap.
const sitemap = (): MetadataRoute.Sitemap => [
  {
    changeFrequency: "weekly",
    lastModified: new Date(),
    priority: 1,
    url: siteConfig.url,
  },
];

export default sitemap;
