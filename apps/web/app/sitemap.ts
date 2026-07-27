import type { MetadataRoute } from "next";

import { siteConfig } from "@/lib/config";

// Only list URLs this site owns. /docs is served by a separate docs platform
// and published through its own sitemap at /docs/sitemap.xml, which robots.txt
// points crawlers at.
const staticRoutes = [""];
const TRAILING_SLASH_REGEX = /\/$/;

const sitemap = (): MetadataRoute.Sitemap => {
  const lastModified = new Date();

  return staticRoutes.map((route) => ({
    changeFrequency: "weekly",
    lastModified,
    priority: 1,
    url: `${siteConfig.url}/${route}`.replace(TRAILING_SLASH_REGEX, ""),
  }));
};

export default sitemap;
