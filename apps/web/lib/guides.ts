import { siteConfig } from "@/lib/config";

/**
 * Marketing guides at `/stratasync/guides`, separate from the reference docs
 * on Blode.md at `/stratasync/docs`.
 *
 * The split is by job, not by topic. Docs guides tell someone already using
 * the library how to do a thing with it. These answer the category questions
 * a person asks before they have chosen anything, which is where the search
 * demand sits: `sync engine` runs 170 a month against 70 for
 * `linear sync engine` (DataForSEO, US, September 2026).
 *
 * One entry per guide. The index page, the sitemap and `llms.txt` all read
 * this, so a new guide reaches every surface by being added here once.
 */

export interface GuideFaq {
  answer: string;
  question: string;
}

export interface Guide {
  /** The 40-to-70-word passage under the H1, quotable without the page. */
  answer: string;
  description: string;
  faq: GuideFaq[];
  /** Primary query first; used for internal reasoning, never stuffed on-page. */
  keywords: string[];
  slug: string;
  title: string;
  /** Content revision date. Bump when the prose changes, not on every deploy. */
  updated: string;
}

export const guides: Guide[] = [
  {
    answer:
      "A sync engine keeps a local copy of your data on every client and reconciles it with the server. Your interface reads and writes that local copy, so screens render immediately and edits survive going offline. The engine ships changes up, applies everyone else's changes down, and resolves conflicts so all clients converge.",
    description:
      "A sync engine keeps a local copy of your data on every client and reconciles it with the server. How the mechanism works, the two families of conflict resolution, and when you should not use one.",
    faq: [
      {
        answer:
          "A cache stores an answer the server already gave you, and the server stays the source of truth for reads and writes. A sync engine holds a replica you also write to, so it has to reconcile your local writes with everyone else's. That reconciliation rule is the part a cache does not have.",
        question: "How is a sync engine different from a cache?",
      },
      {
        answer:
          "Optimistic updates are enough when one screen writes one record and a failure can be resolved by refetching. You need a sync engine once writes must survive a reload, several screens read the same record and have to agree, or a client can be offline long enough that replaying its writes needs an ordering rule rather than a retry.",
        question: "Do I need a sync engine, or just optimistic updates?",
      },
      {
        answer:
          "That depends on the reconciliation family. A CRDT merges both edits without a coordinator, at the cost of per-value metadata. A server-ordered log gives the server the final say: it assigns each change a number, and clients rebase their pending writes on top of what arrives. Field-level rebase means two people editing different fields of one record do not collide at all.",
        question: "What happens when two people edit the same record?",
      },
      {
        answer:
          "With a server-ordered log the client stores the sequence number it last saw, asks for everything after that integer, and replays its queued writes on top. The catch-up cost is proportional to what changed, not to the size of the dataset, which is the main practical reason to order changes centrally.",
        question: "What happens when a client has been offline for a week?",
      },
      {
        answer:
          "No. CRDTs are one way to reconcile, and they are the right one for text, where two people type into the same paragraph. For records, a server-ordered log is usually simpler: there is no merge function to reason about, and partial replication and per-row permissions fall out of the same mechanism.",
        question: "Does a sync engine mean I have to use CRDTs?",
      },
      {
        answer:
          "A data-model commitment. Every synced type needs a stable identity, a defined conflict rule, and a decision about which clients are allowed to see it. You also carry a local store to migrate as your schema changes. It is not a library you swap in behind an existing fetch layer.",
        question: "What does a sync engine cost me in practice?",
      },
    ],
    keywords: [
      "sync engine",
      "local first sync engine",
      "offline first sync",
      "what is a sync engine",
    ],
    slug: "what-is-a-sync-engine",
    title: "What a sync engine is, and when you need one",
    updated: "2026-09-06",
  },
  {
    answer:
      "The open-source sync engines differ on three things: whether they own your database, whether you run an extra service, and whether writes go through them or through your own API. Convex owns the database. Electric and Zero sit beside your Postgres. Strata Sync runs inside your Fastify app.",
    description:
      "Strata Sync, Zero, ElectricSQL, Convex, InstantDB and PowerSync compared on database ownership, services to operate, the write path, conflict resolution, and collaborative text.",
    faq: [
      {
        answer:
          "Convex brings its own managed database rather than syncing your Postgres. Queries are reactive and mutations run as server-side functions with optimistic concurrency control and transaction atomicity. Pick it when you want one product to own the backend. Pick a Postgres-based engine when the database already exists and has to stay yours.",
        question: "How does Convex compare to a Postgres-based sync engine?",
      },
      {
        answer:
          "Zero runs zero-cache beside your Postgres and gives you ZQL, its own query language, with server-authoritative rebasing. Strata Sync registers routes on your existing Fastify app instead of adding a process, and you declare model classes rather than write queries in a new language. Zero is the better pick if you want queries as the primary abstraction.",
        question: "What is the difference between Strata Sync and Zero?",
      },
      {
        answer:
          "ElectricSQL streams filtered subsets of Postgres to clients in real time and deliberately leaves the write path to your own API. That keeps its architecture small. It also means the outbox, retry and conflict handling are yours to build, which is the part a full sync engine ships for you.",
        question: "Is ElectricSQL a full sync engine?",
      },
      {
        answer:
          "None of them ship it. Record-level ordering handles text badly, because two people typing in one paragraph is the case a single ordering cannot merge sensibly. Strata Sync includes Yjs CRDT documents and presence for text fields; the others expect you to add a CRDT layer yourself.",
        question: "Which sync engines handle collaborative text editing?",
      },
    ],
    keywords: [
      "sync engine comparison",
      "zero sync alternative",
      "electricsql alternative",
      "convex alternative",
    ],
    slug: "sync-engine-comparison",
    title: "Sync engines compared: Strata Sync, Zero, Electric, Convex",
    updated: "2026-09-06",
  },
];

export const guideUrl = (slug: string): string =>
  `${siteConfig.url}/guides/${slug}`;

export const getGuide = (slug: string): Guide | undefined =>
  guides.find((guide) => guide.slug === slug);
