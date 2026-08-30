export const siteConfig = {
  answer:
    "Strata Sync is an open-source, local-first sync engine for TypeScript, React, and Next.js. It is a developer library for application data sync, not a network-management platform.",
  description:
    "Build local-first TypeScript, React, and Next.js apps with instant reads, offline writes, real-time collaboration, and field-level conflict resolution.",
  heading: "Local-first sync engine for TypeScript",
  links: {
    author: "https://blode.co",
    docs: "https://blode.co/stratasync/docs",
    github: "https://github.com/mblode/stratasync",
    projects: "https://blode.co/projects",
  },
  name: "Strata Sync",
  title: "Local-first sync engine for TypeScript | Strata Sync",
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
    // "Matthew Blode", not "Home": the root crumb is the one piece of chrome
    // every zone shows above the fold, and it must match the visible trail in
    // `components/zone-breadcrumb.tsx` exactly or Google reads the mismatch as
    // a markup error.
    {
      "@type": "ListItem",
      item: `${host}/`,
      name: "Matthew Blode",
      position: 1,
    },
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
      description: siteConfig.answer,
      headline: siteConfig.heading,
      inLanguage: "en-US",
      isPartOf: { "@id": websiteId },
      mainEntity: { "@id": appId },
      name: siteConfig.title,
      url: siteConfig.url,
    },
    {
      "@id": appId,
      "@type": "SoftwareSourceCode",
      author: { "@id": personId },
      codeRepository: siteConfig.links.github,
      description: siteConfig.answer,
      isAccessibleForFree: true,
      keywords: [
        "local-first sync engine",
        "offline-first TypeScript",
        "React data sync",
        "Next.js data sync",
      ],
      name: siteConfig.name,
      programmingLanguage: "TypeScript",
      publisher: { "@id": orgId },
      runtimePlatform: "Node.js",
      url: siteConfig.url,
    },
    breadcrumbSchema(),
  ],
};
