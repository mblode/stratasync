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
      "Supabase Realtime broadcasts database changes to connected clients. It does not keep a local replica, queue writes made offline, or reconcile conflicting edits, so it is a live feed rather than a sync engine. Strata Sync adds those three things on top of the Postgres that Supabase already gives you.",
    description:
      "Supabase Realtime streams changes to connected clients but keeps no local replica and no offline write queue. How to add a sync engine to a Supabase Postgres, and what it costs you.",
    faq: [
      {
        answer:
          "Realtime pushes changes to clients that are connected right now, through Broadcast, Presence and Postgres Changes. A sync engine also keeps a replica on the client, applies writes to it before the server has seen them, queues those writes while offline, and reconciles them on reconnect. Realtime gives you the push. The replica and the reconciliation are the parts you would otherwise build.",
        question: "Is Supabase Realtime a sync engine?",
      },
      {
        answer:
          "Yes. The sync log is three ordinary Postgres tables using bigserial, uuid, text, jsonb and timestamps, with no extensions, no logical replication and no LISTEN/NOTIFY. They run on a Supabase database unmodified, and the rest of your schema is untouched.",
        question: "Can Strata Sync run on a Supabase database?",
      },
      {
        answer:
          "A Node process. Strata Sync's server is a set of Fastify routes, and Supabase does not host arbitrary Node servers: Edge Functions are Deno. You run that process wherever you already run one, on Fly, Railway, Render or a container, and point it at your Supabase connection string.",
        question: "What do I still need to run alongside Supabase?",
      },
      {
        answer:
          "Use the session-mode connection or set `prepare: false` on postgres-js. Supabase's pooler in transaction mode does not support prepared statements, which postgres-js uses by default. This is the standard requirement for that combination rather than anything specific to Strata Sync.",
        question: "Does Strata Sync work with the Supabase connection pooler?",
      },
      {
        answer:
          "Strata Sync authorises writes itself, through sync groups resolved server-side, and it connects as an ordinary Postgres role. If you rely on row level security for the same tables, decide which layer owns the rule rather than running both and hoping they agree.",
        question: "How does this interact with Supabase row level security?",
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
      "Convex and Supabase are both backends, and they disagree about ownership. Convex gives you a managed reactive database with server functions, and owns the data. Supabase gives you a Postgres you own, plus auth, storage and a realtime feed. Neither ships a full sync engine.",
    description:
      "Convex and Supabase compared on data ownership, queries, realtime, and what neither gives you: a local replica with offline writes and conflict resolution.",
    faq: [
      {
        answer:
          "Convex brings its own managed database with reactive queries and server-side mutation functions, using optimistic concurrency control and transaction atomicity. Supabase gives you a standard Postgres you can connect anything to, plus auth, storage and Realtime. The question underneath is whether you want to own the database.",
        question: "What is the difference between Convex and Supabase?",
      },
      {
        answer:
          "Convex queries are reactive by default: they re-run and push to connected clients as the underlying data changes. Supabase pushes changes through Realtime, which you subscribe to separately from your queries. Convex integrates the two, Supabase keeps them apart, and the second is easier to reason about at the cost of more wiring.",
        question: "How does reactivity differ between Convex and Supabase?",
      },
      {
        answer:
          "Neither. Both push changes to connected clients, and neither keeps a local replica you write to, queues writes made offline, or rebases them on reconnect. If you need those, you add them on top, which is what a sync engine is for.",
        question: "Does Convex or Supabase give me offline support?",
      },
      {
        answer:
          "Supabase, because a standard Postgres is the easier thing to migrate away from and the easier thing to attach other tools to. Convex's data lives in Convex, so leaving means an export and a rewrite of every server function. That is a fair trade for what it gives you, but it is worth pricing before you start.",
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
      "Convex and Strata Sync solve the same problem from opposite ends. Convex brings its own managed reactive database and runs your writes as server functions. Strata Sync syncs the Postgres you already run, from routes inside your own Fastify app. The choice is mostly about who owns the database.",
    description:
      "Convex and Strata Sync compared: managed reactive database against your own Postgres, server functions against a durable outbox, and where the two architectures actually agree.",
    faq: [
      {
        answer:
          "Convex brings its own managed database, so your data lives in Convex rather than in a Postgres you operate. Strata Sync never owns your data: it reads and writes the database you already run, through routes registered on your existing Fastify app. If the database has other consumers or has to stay where it is, that difference decides it.",
        question: "What is the main difference between Convex and Strata Sync?",
      },
      {
        answer:
          "Yes, self-hosting is available, though the managed cloud deployment is the default path and the one most of the documentation assumes. Strata Sync has no hosted option at all, because there is nothing to host: it is a library that runs inside your app and stores its sync log in your Postgres.",
        question: "Can you self-host Convex?",
      },
      {
        answer:
          "More than the surface suggests. Convex uses optimistic concurrency control with transaction atomicity and a strictly increasing sequence identifier. Strata Sync assigns every change a monotonic syncId and has clients replay that order. Both are server-authoritative and both let a client catch up by asking for everything after a number, rather than merging without a coordinator.",
        question:
          "How do Convex and Strata Sync differ on ordering and conflicts?",
      },
      {
        answer:
          "Neither ships it. Record-level ordering handles text badly, because two people typing in one paragraph is the case a single ordering cannot merge sensibly. Strata Sync includes Yjs documents and presence for text fields through @stratasync/y-doc. With Convex you add a CRDT layer yourself.",
        question: "Does Convex support collaborative text editing?",
      },
      {
        answer:
          "Choose Convex when you are starting fresh and want one product to own the database, the server functions and the sync, and you are happy for that product to be the backend. Choose Strata Sync when the Postgres already exists, has other consumers, or has to stay yours, and you want Linear's architecture rather than a new backend.",
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
      "Zero and Strata Sync are both server-authoritative sync engines over your own Postgres. Zero runs zero-cache beside the database and gives you ZQL, its own query language. Strata Sync registers routes on your existing Fastify app and has you declare model classes instead.",
    description:
      "Zero and Strata Sync compared: an extra cache process against routes in your own app, ZQL against model classes, and when Zero is the better pick.",
    faq: [
      {
        answer:
          "Zero introduces zero-cache, a process between your client and Postgres that holds the replica the server reasons about, and which you run, scale and monitor. Strata Sync introduces routes: @stratasync/server registers bootstrap, mutate and a WebSocket on the Fastify app you already deploy. Redis is optional and only for fan-out across instances.",
        question: "Does Zero require running an extra service?",
      },
      {
        answer:
          "Zero ships ZQL, a query language of its own, and queries are subscriptions that update as the underlying data changes. Strata Sync follows Linear: you declare model classes with decorators and read them back through typed queries and React hooks, against a local replica, with no new query language to learn.",
        question: "What is the difference between ZQL and Strata Sync queries?",
      },
      {
        answer:
          "Both are server-authoritative and both rebase, so neither asks you to reason about CRDT merge semantics for records. Strata Sync resolves conflicts per field rather than per record, so two people editing different fields of the same row do not collide at all.",
        question: "How do Zero and Strata Sync handle conflicts?",
      },
      {
        answer:
          "Pick Zero if you want queries as the primary abstraction, you like ZQL, and you are happy to operate zero-cache. Pick Zero too if you want the backing of a team whose whole product this is: Strata Sync is one author plus contributors, in production on one product.",
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
          "None of them ship it. Record-level ordering handles text badly, because two people typing in one paragraph is the case a single ordering cannot merge sensibly. Strata Sync includes Yjs CRDT documents and presence for text fields. The others expect you to add a CRDT layer yourself.",
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
