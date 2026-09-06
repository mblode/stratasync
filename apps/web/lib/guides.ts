import { siteConfig } from "@/lib/config";

/**
 * Marketing guides at `/stratasync/guides`, separate from the reference docs
 * on Blode.md at `/stratasync/docs`.
 *
 * Docs tell someone already using the library how to do a thing with it.
 * These answer the questions asked before choosing anything, which is where
 * the search demand sits: `sync engine` runs 170 a month against 70 for
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
  /** The passage under the H1, quotable without the page. */
  answer: string;
  description: string;
  faq: GuideFaq[];
  /** Primary query first. Never stuffed on-page. */
  keywords: string[];
  slug: string;
  title: string;
  /** Content revision date. Bump when the prose changes, not on deploy. */
  updated: string;
}

export const guides: Guide[] = [
  {
    answer:
      "A sync engine keeps a copy of your data on each device and reconciles it with the server. Screens render at once, edits work offline, and every client ends up in the same state.",
    description:
      "What a sync engine does, the two ways it resolves conflicts, and when you should not use one.",
    faq: [
      {
        answer:
          "A cache holds answers the server already gave you. A sync engine holds a copy you also write to, so it has to reconcile your writes with everyone else's.",
        question: "How is a sync engine different from a cache?",
      },
      {
        answer:
          "Optimistic updates are enough when one screen writes one record and a refetch fixes any failure. You need a sync engine once writes must survive a reload or a long stretch offline.",
        question: "Do I need a sync engine, or just optimistic updates?",
      },
      {
        answer:
          "With a server-ordered log the server decides, and clients rebase their pending writes on top. Field-level rebase means two people editing different fields never collide.",
        question: "What happens when two people edit the same record?",
      },
      {
        answer:
          "A data-model commitment. Every synced type needs a stable id, a conflict rule and a decision about who can see it, plus a local store you migrate as the schema changes.",
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
    updated: "2026-09-07",
  },
  {
    answer:
      "Strata Sync is an open-source TypeScript implementation of the sync engine behind Linear. This page maps each part of Linear's published design onto the module here that implements it.",
    description:
      "Linear's sync engine architecture mapped, part by part, onto the Strata Sync modules that implement it.",
    faq: [
      {
        answer:
          "No. It is a clean-room implementation of the architecture Linear's engineers described publicly. It contains no Linear code, and Linear is not affiliated with the project.",
        question: "Is Strata Sync Linear's actual code?",
      },
      {
        answer:
          "One server numbers every change, and every client replays changes in that order. There is no merge step for records, because the server already decided.",
        question: "What is a server-sequenced log?",
      },
      {
        answer:
          "It asks for everything after the last sync id it saw, applies those changes, then rebases its own queued writes on top. The cost scales with what changed, not with the dataset.",
        question: "How does a client catch up after a week offline?",
      },
      {
        answer:
          "Collaborative text through Yjs, swappable storage, transport and reactivity adapters, and a server you own: Fastify routes and a Postgres log, with no hosted dependency.",
        question: "What does Strata Sync add beyond Linear's design?",
      },
    ],
    keywords: [
      "linear sync engine",
      "linear sync engine github",
      "linear sync engine example",
      "open source sync engine",
    ],
    slug: "linear-sync-engine",
    title: "Linear's sync engine, open-sourced",
    updated: "2026-09-07",
  },
  {
    answer:
      "Supabase Realtime pushes database changes to connected clients. It keeps no local copy, no offline write queue and no conflict resolution. Strata Sync adds those three on top of the Postgres Supabase already gives you.",
    description:
      "Supabase Realtime is a live feed, not a sync engine. How to add one to a Supabase Postgres, and what it costs you.",
    faq: [
      {
        answer:
          "No. Realtime pushes changes to clients that are connected right now. A sync engine also keeps a local copy, queues writes made offline and reconciles them on reconnect.",
        question: "Is Supabase Realtime a sync engine?",
      },
      {
        answer:
          "Yes. The sync log is three plain Postgres tables with no extensions, no logical replication and no LISTEN/NOTIFY. Your existing schema is untouched.",
        question: "Can Strata Sync run on a Supabase database?",
      },
      {
        answer:
          "A Node process. The server is a set of Fastify routes, and Supabase Edge Functions are Deno. Run it on Fly, Railway, Render or a container and point it at your connection string.",
        question: "What do I still need to run alongside Supabase?",
      },
      {
        answer:
          "Use the session-mode connection, or set prepare: false on postgres-js. The pooler in transaction mode does not support prepared statements.",
        question: "Does Strata Sync work with the Supabase connection pooler?",
      },
    ],
    keywords: [
      "supabase realtime",
      "supabase offline",
      "supabase sync",
      "supabase local first",
    ],
    slug: "supabase-sync-engine",
    title: "Adding a sync engine to Supabase",
    updated: "2026-09-07",
  },
  {
    answer:
      "Convex owns the database and runs your writes as server functions. Supabase gives you a Postgres you own, plus auth, storage and a realtime feed. Neither ships a full sync engine.",
    description:
      "Convex and Supabase compared on ownership, reactivity, leaving, and the offline gap neither one closes.",
    faq: [
      {
        answer:
          "Convex brings its own managed reactive database. Supabase gives you a standard Postgres you can connect anything to. The real question is whether you want to own the database.",
        question: "What is the difference between Convex and Supabase?",
      },
      {
        answer:
          "Convex queries re-run and push to clients on their own. Supabase pushes through Realtime, which you subscribe to separately. More wiring, and easier to reason about.",
        question: "How does reactivity differ between Convex and Supabase?",
      },
      {
        answer:
          "Neither. Both push to connected clients. Neither keeps a local copy you write to, queues offline writes, or rebases them on reconnect.",
        question: "Does Convex or Supabase give me offline support?",
      },
      {
        answer:
          "Supabase. A standard Postgres is easy to move and easy to attach tools to. Leaving Convex means an export and a rewrite of every server function.",
        question: "Which is easier to move off later?",
      },
    ],
    keywords: [
      "convex vs supabase",
      "supabase vs convex",
      "convex alternative",
      "supabase realtime",
    ],
    slug: "convex-vs-supabase",
    title: "Convex vs Supabase",
    updated: "2026-09-07",
  },
  {
    answer:
      "Convex brings its own managed database and runs writes as server functions. Strata Sync syncs the Postgres you already run, from routes inside your own app. The choice is mostly about who owns the database.",
    description:
      "Convex and Strata Sync compared: a managed database against your own Postgres, and where the two designs agree.",
    faq: [
      {
        answer:
          "Convex owns the data. Strata Sync never does: it reads and writes the database you already run. If that database has other consumers, that decides it.",
        question: "What is the main difference between Convex and Strata Sync?",
      },
      {
        answer:
          "Yes, though the managed cloud is the default path. Strata Sync has nothing to host: it is a library inside your app, with its log in your Postgres.",
        question: "Can you self-host Convex?",
      },
      {
        answer:
          "They are closer than they look. Both are server-authoritative, and both let a client catch up by asking for everything after a number. Strata Sync also resolves conflicts per field.",
        question:
          "How do Convex and Strata Sync differ on ordering and conflicts?",
      },
      {
        answer:
          "Choose Convex when you are starting fresh and want one product to own the backend. Choose Strata Sync when the Postgres already exists and has to stay yours.",
        question: "When should I choose Convex over Strata Sync?",
      },
    ],
    keywords: [
      "convex alternative",
      "convex vs strata sync",
      "convex sync engine",
      "convex vs zero",
    ],
    slug: "strata-sync-vs-convex",
    title: "Strata Sync vs Convex",
    updated: "2026-09-07",
  },
  {
    answer:
      "Both are server-authoritative sync engines over your own Postgres. Zero runs zero-cache beside the database and gives you ZQL, its own query language. Strata Sync registers routes on your app and has you declare model classes.",
    description:
      "Zero and Strata Sync compared: an extra process against routes in your own app, ZQL against model classes, and when Zero is the better pick.",
    faq: [
      {
        answer:
          "Yes. zero-cache sits between your client and Postgres, and you run, scale and monitor it. Strata Sync adds routes to the Fastify app you already deploy.",
        question: "Does Zero require running an extra service?",
      },
      {
        answer:
          "ZQL is a query language of its own, and queries are subscriptions. Strata Sync has you declare model classes and read them through typed queries and hooks, with nothing new to learn.",
        question: "What is the difference between ZQL and Strata Sync queries?",
      },
      {
        answer:
          "Both are server-authoritative and both rebase. Strata Sync resolves conflicts per field, so two people editing different fields of one row never collide.",
        question: "How do Zero and Strata Sync handle conflicts?",
      },
      {
        answer:
          "When you want queries as the main abstraction, you are happy to operate zero-cache, or you want a team whose whole product this is.",
        question: "When should I choose Zero over Strata Sync?",
      },
    ],
    keywords: [
      "zero sync alternative",
      "zero vs strata sync",
      "rocicorp zero alternative",
      "zero sync engine",
    ],
    slug: "strata-sync-vs-zero",
    title: "Strata Sync vs Zero",
    updated: "2026-09-07",
  },
  {
    answer:
      "The open-source sync engines differ on three things: whether they own your database, whether you run an extra service, and whether writes go through them or your own API.",
    description:
      "Strata Sync, Zero, ElectricSQL, Convex, InstantDB and PowerSync on the three questions that actually separate them.",
    faq: [
      {
        answer:
          "Convex brings its own database and runs writes as server functions. Pick it to have one product own the backend. Pick a Postgres-based engine when the database is already yours.",
        question: "How does Convex compare to a Postgres-based sync engine?",
      },
      {
        answer:
          "Zero adds zero-cache and its own query language. Strata Sync adds routes to your app and uses model classes. Zero is the better pick if you want queries as the main abstraction.",
        question: "What is the difference between Strata Sync and Zero?",
      },
      {
        answer:
          "It streams filtered Postgres data to clients and leaves writes to your own API. The outbox, retries and conflict handling are yours to build.",
        question: "Is ElectricSQL a full sync engine?",
      },
      {
        answer:
          "None of them ship it. Strata Sync includes Yjs documents and presence for text fields. The others expect you to add a CRDT layer.",
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
    updated: "2026-09-07",
  },
];

export const guideUrl = (slug: string): string =>
  `${siteConfig.url}/guides/${slug}`;

export const getGuide = (slug: string): Guide | undefined =>
  guides.find((guide) => guide.slug === slug);
