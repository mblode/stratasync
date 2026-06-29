import type { MetadataRoute } from "next";

import { siteConfig } from "@/lib/config";

// Only list URLs this site canonicalises to itself. /docs is served by a
// separate docs platform that canonicalises to its own host and publishes its
// own sitemap, so listing it here produces a non-canonical sitemap entry.
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
