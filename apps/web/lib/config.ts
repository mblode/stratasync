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
    "Strata Sync is an open-source TypeScript implementation of Linear's server-sequenced sync engine for React and Next.js. Reads come from a local IndexedDB replica, writes queue offline, and every client converges on one server-ordered log. It runs on your own Postgres and Fastify. No hosted service, MIT licence.",
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
  links: {
    author: "https://blode.co",
    docs: "https://blode.co/stratasync/docs",
    doneBear: "https://donebear.com",
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
      "A sync engine keeps a local copy of application data on each client and reconciles it with the server. The UI reads and writes the local copy, so screens render at once and edits work offline. The engine ships changes to the server, applies other clients' changes, and resolves conflicts, so every client converges on the same state.",
    question: "What is a sync engine?",
  },
  {
    answer:
      "Yes. Strata Sync is a clean-room implementation of the sync architecture Linear's engineers described publicly: a model registry with decorators, bootstrap keyed by a global lastSyncId, partial indexes with batch loading, a durable transaction queue, delta packets of sync actions, sync groups and undo from transaction history. It contains no Linear code, and Linear is not affiliated with the project.",
    question: "Is Strata Sync an implementation of Linear's sync engine?",
  },
  {
    answer:
      "Neither for records, Yjs CRDTs for text. Records use a server-sequenced log: the server assigns every change a monotonic syncId, and clients rebase pending writes on top of incoming deltas with field-level conflict detection. Collaborative text fields use Yjs CRDT documents through @stratasync/y-doc, so several people can type in one document without a central lock.",
    question: "Is Strata Sync CRDT-based or OT-based?",
  },
  {
    answer:
      "No. Strata Sync has zero hosted dependencies. @stratasync/server registers the bootstrap, batch, deltas, mutate and WebSocket routes on your own Fastify instance and stores the sync log in your own Postgres through Drizzle. Redis is optional, for fanning deltas out across several server processes. Every package is MIT licensed.",
    question: "Does Strata Sync need a hosted service?",
  },
  {
    answer:
      "Yes. Reads come from an IndexedDB replica, so queries return without a network round-trip. Writes apply to the in-memory model immediately and sit in a durable outbox until the server confirms them. On reconnect the client fetches the deltas it missed after its stored lastSyncId, rebases the outbox on top and drains it in order, with idempotency keys so a retry never applies twice.",
    question: "Does Strata Sync work offline?",
  },
  {
    answer:
      "Every mutation records an inverse operation in a history stack. client.undo() sends that inverse as a normal transaction, so it syncs to the server and other clients see it as an ordinary update, delete or insert. runAsUndoGroup() collapses several mutations into one undoable step, and a server rejection drops the entry from both stacks.",
    question: "How does undo and redo work in Strata Sync?",
  },
  {
    answer:
      "Zero and ElectricSQL run a sync service beside your Postgres and stream query results down; Replicache is a client library where you write the push and pull endpoints. Strata Sync is a full client and server pair built on Linear's server-sequenced log: it ships the outbox, the write path, rebase, sync groups, undo and Yjs text, and runs inside your own Fastify app.",
    question:
      "How does Strata Sync compare to Zero, ElectricSQL and Replicache?",
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
