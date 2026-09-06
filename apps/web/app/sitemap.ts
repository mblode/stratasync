import type { MetadataRoute } from "next";

import { siteConfig } from "@/lib/config";
import { docsPages } from "@/lib/docs-nav";
import { guides, guideUrl } from "@/lib/guides";

/*
 * `priority` and `changeFrequency` are ignored by Google, so they are not
 * emitted. `lastModified` is only set where a real revision date exists:
 * `new Date()` marked every URL as changed on every deploy, which is how a
 * site teaches Google to ignore its `lastmod` altogether. Docs pages carry no
 * revision date yet, and no date beats a false one.
 */
const sitemap = (): MetadataRoute.Sitemap => [
  {
    lastModified: new Date(siteConfig.updatedAt),
    url: siteConfig.url,
  },
  {
    lastModified: new Date(siteConfig.updatedAt),
    url: `${siteConfig.url}/guides`,
  },
  ...guides.map((guide) => ({
    lastModified: new Date(guide.updated),
    url: guideUrl(guide.slug),
  })),
  ...docsPages.map((page) => ({ url: page.url })),
];

export default sitemap;
