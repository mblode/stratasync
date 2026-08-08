export const siteConfig = {
  description:
    "A local-first sync engine for TypeScript, React, and Next.js. Instant reads, offline writes, and real-time collaboration.",
  links: {
    author: "https://blode.co",
    // Docs stay on the custom domain until the docs worker is zone-ified.
    docs: "https://stratasync.dev/docs",
    github: "https://github.com/mblode/stratasync",
    projects: "https://blode.co/projects",
  },
  name: "Strata Sync",
  url: "https://blode.co/stratasync",
} as const;

/**
 * Stable schema.org node ids. Person, WebSite and Organization belong to
 * blode.co and are only referenced here, never redefined. Contract:
 * blode-co/apps/web/.claude/knowledge/zone-conventions.md
 */
const host = "https://blode.co";

export const personId = `${host}/#person`;
export const websiteId = `${host}/#website`;
export const orgId = `${host}/#organization`;

export const appId = `${siteConfig.url}/#software`;
export const webPageId = `${siteConfig.url}/#webpage`;
export const breadcrumbId = `${siteConfig.url}/#breadcrumb`;

export const breadcrumbSchema = () => ({
  "@id": breadcrumbId,
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", item: `${host}/`, name: "Home", position: 1 },
    {
      "@type": "ListItem",
      item: `${host}/projects`,
      name: "Projects",
      position: 2,
    },
    {
      "@type": "ListItem",
      item: siteConfig.url,
      name: siteConfig.name,
      position: 3,
    },
  ],
});

export const zoneRootJsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@id": webPageId,
      "@type": "WebPage",
      about: { "@id": appId },
      breadcrumb: { "@id": breadcrumbId },
      description: siteConfig.description,
      inLanguage: "en-US",
      isPartOf: { "@id": websiteId },
      name: siteConfig.name,
      url: siteConfig.url,
    },
    {
      "@id": appId,
      "@type": "SoftwareSourceCode",
      author: { "@id": personId },
      codeRepository: siteConfig.links.github,
      description: siteConfig.description,
      name: siteConfig.name,
      programmingLanguage: "TypeScript",
      publisher: { "@id": orgId },
      runtimePlatform: "Node.js",
      url: siteConfig.url,
    },
    breadcrumbSchema(),
  ],
};
