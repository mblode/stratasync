/**
 * One copy of the positioning, read by the page, the OG card, the markdown
 * and llms.txt routes, the JSON-LD and `scripts/seo-smoke.ts`. Change a line
 * here and every surface moves together.
 *
 * Category term to own: "local-first sync engine". Hook: Linear's architecture,
 * open-sourced. Proof: Done Bear in production, your own Postgres, no hosted
 * service.
 */
export const siteConfig = {
  /**
   * The direct answer under the H1. Written as one self-contained passage
   * (about 50 words) so an answer engine can quote it without the page.
   */
  answer:
    "Strata Sync is an open-source implementation of Linear's sync engine for TypeScript. Local reads, offline writes, one server-ordered log, on your own Postgres. MIT.",
  /** Search snippet. Under 160 characters. */
  description:
    "Open-source, local-first sync engine for TypeScript, React and Next.js: Linear's server-sequenced architecture on your own Postgres, with offline writes, Yjs and undo. MIT.",
  /**
   * Disambiguation for the "strata sync" query, which Search Console shows
   * mostly means strata (body-corporate) management software in Australia.
   */
  disambiguation:
    "A developer library for application data sync. Not a strata-management or network-management product.",
  heading: "The local-first sync engine Linear never open-sourced",
  /** The two ways in, one per audience. The hero switches between them. */
  install: {
    agents: "npx skills add mblode/stratasync",
    humans: "npx stratasync init my-app",
  },
  links: {
    author: "https://blode.co",
    docs: "https://blode.co/stratasync/docs",
    doneBear: "https://donebear.com",
    gettingStarted: "https://blode.co/stratasync/docs/getting-started",
    github: "https://github.com/mblode/stratasync",
    linearReference: "https://github.com/wzhudev/reverse-linear-sync-engine",
    npm: "https://www.npmjs.com/package/@stratasync/core",
    projects: "https://blode.co/projects",
  },
  name: "Strata Sync",
  /**
   * Browser tab and search title. Under 60 characters, category term first,
   * brand last, so a "linear sync engine open source" result reads as the
   * answer rather than a brand name nobody has searched for yet.
   */
  title: "Open-source Linear sync engine for TypeScript | Strata Sync",
  /**
   * Last content revision, surfaced in the sitemap and JSON-LD. Bump when the
   * page copy changes; a `new Date()` here would claim a fresh edit on every
   * build.
   */
  updatedAt: "2026-09-01",
  url: "https://blode.co/stratasync",
} as const;

/**
 * The `/how-it-works` explainer. Top-level rather than a guide: it argues one
 * mechanism across ten figures instead of answering a question, so it carries
 * its own shell. The page, the sitemap, `llms.txt` and the nav all read this,
 * so the page reaches every surface by being described here once.
 */
export const howItWorks = {
  /** The passage under the H1, quotable without the page. */
  answer:
    "A sync engine keeps the data on the device and reconciles it with a server that numbers every change. This page builds one from a single checkbox: local reads, an ordered log, an offline write queue, a rebase step for what you missed, and a CRDT for text.",
  description:
    "A sync engine built up from nothing: local reads, a server-numbered log, an offline outbox, field-level rebase, and Yjs for text. Ten figures, one idea each.",
  /** Primary query first. Nothing in `/guides` currently targets it. */
  keywords: [
    "how does a sync engine work",
    "sync engine explained",
    "optimistic updates offline queue",
    "server sequenced sync log",
  ],
  title: "How a sync engine works, built from one checkbox",
  /** Content revision date. Bump when the prose changes, not on deploy. */
  updated: "2026-09-07",
  url: `${siteConfig.url}/how-it-works`,
} as const;

/** Numbers the copy leans on. Keep them true or delete the claim. */
export const proofPoints = {
  hostedDependencies: 0,
  licence: "MIT",
  packageCount: 10,
} as const;

/**
 * Questions people put to answer engines about this category, each answered
 * in one self-contained passage of 40 to 70 words. Rendered visibly on the
 * page and mirrored into the FAQPage node below, so the markup never says
 * anything the page does not.
 */
export const faq = [
  {
    answer:
      "A sync engine keeps a copy of your data on each device and reconciles it with the server. Screens render at once, edits work offline, and every client ends up in the same state.",
    question: "What is a sync engine?",
  },
  {
    answer:
      "Yes, a clean-room one. It follows the architecture Linear's engineers described publicly: decorated models, bootstrap keyed by a global sync id, a durable transaction queue, delta packets and sync groups. It contains no Linear code, and Linear is not affiliated with the project.",
    question: "Is Strata Sync an implementation of Linear's sync engine?",
  },
  {
    answer:
      "No. The server is a set of Fastify routes that store the sync log in your own Postgres through Drizzle. Redis is optional, for fan-out across processes. Every package is MIT.",
    question: "Does Strata Sync need a hosted service?",
  },
  {
    answer:
      "Yes. Reads come from an IndexedDB copy. Writes apply at once and wait in a durable outbox. On reconnect the client fetches what it missed, rebases the outbox on top and drains it, with idempotency keys so nothing applies twice.",
    question: "Does Strata Sync work offline?",
  },
] as const;

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
export const faqId = `${siteConfig.url}/#faq`;

interface Crumb {
  name: string;
  url: string;
}

/**
 * `trail` appends crumbs below the zone root, for pages deeper than
 * `/stratasync`. Anything passed here must also render in the visible trail:
 * a BreadcrumbList naming a crumb the page does not show is a structured-data
 * policy violation, and answer engines read the DOM rather than the script.
 */
export const breadcrumbSchema = (trail: Crumb[] = [], id = breadcrumbId) => ({
  "@id": id,
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
    ...trail.map((crumb, index) => ({
      "@type": "ListItem",
      item: crumb.url,
      name: crumb.name,
      position: 4 + index,
    })),
  ],
});

export const faqSchema = () => ({
  "@id": faqId,
  "@type": "FAQPage",
  mainEntity: faq.map((entry) => ({
    "@type": "Question",
    acceptedAnswer: {
      "@type": "Answer",
      text: entry.answer,
    },
    name: entry.question,
  })),
});

// Injected by next.config.js from packages/core/package.json; absent when the
// config is imported outside Next (the seo smoke script), so the field is
// omitted rather than published as "undefined".
const softwareVersion = process.env.STRATASYNC_VERSION;

export const zoneRootJsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@id": webPageId,
      "@type": "WebPage",
      about: { "@id": appId },
      breadcrumb: { "@id": breadcrumbId },
      dateModified: siteConfig.updatedAt,
      description: siteConfig.answer,
      headline: siteConfig.heading,
      inLanguage: "en-AU",
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
      disambiguatingDescription: siteConfig.disambiguation,
      isAccessibleForFree: true,
      keywords: [
        "local-first sync engine",
        "Linear sync engine open source",
        "sync engine TypeScript",
        "offline-first React",
        "offline-first TypeScript",
        "Next.js data sync",
        "server-sequenced sync",
        "Yjs collaboration",
      ],
      license: "https://opensource.org/licenses/MIT",
      name: siteConfig.name,
      programmingLanguage: "TypeScript",
      publisher: { "@id": orgId },
      runtimePlatform: "Node.js",
      sameAs: [siteConfig.links.npm],
      ...(softwareVersion ? { softwareVersion } : {}),
      url: siteConfig.url,
    },
    breadcrumbSchema(),
    faqSchema(),
  ],
};

/**
 * Serialise JSON-LD for a `<script>` tag.
 *
 * `JSON.stringify` does not escape `<`, so a value containing `</script>`
 * would close the tag and turn a copy edit into script injection. Escaping
 * unconditionally is the rule the Next.js JSON-LD guide gives; deciding field
 * by field whether HTML could appear is how that regression gets introduced
 * later.
 */
export const jsonLdScript = (data: unknown): string =>
  JSON.stringify(data).replaceAll("<", "\\u003c");
