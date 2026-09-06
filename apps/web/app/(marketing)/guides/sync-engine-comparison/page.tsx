import type { Metadata } from "next";

import { GuideShell } from "@/components/guide-shell";
import { siteConfig } from "@/lib/config";
import { getGuide, guideUrl } from "@/lib/guides";

const guide = getGuide("sync-engine-comparison");

if (!guide) {
  throw new Error("Missing guide entry: sync-engine-comparison");
}

export const metadata: Metadata = {
  alternates: { canonical: guideUrl(guide.slug) },
  description: guide.description,
  openGraph: {
    description: guide.description,
    images: [`${siteConfig.url}/opengraph-image`],
    siteName: "Matthew Blode",
    title: guide.title,
    type: "article",
    url: guideUrl(guide.slug),
  },
  title: guide.title,
};

/**
 * Rows describe each project's documented default architecture, worded to stay
 * true as those projects add features. "Bring your own" is a design choice
 * rather than a gap, and is written as one.
 */
const rows = [
  {
    convex: "Convex's own managed database",
    electric: "Your Postgres + Electric service",
    feature: "Where your data lives",
    instant: "Instant's hosted database",
    powersync: "Your database + PowerSync Service",
    strata: "Your Postgres, inside your Fastify app",
    zero: "Your Postgres + zero-cache",
  },
  {
    convex: "Convex cloud, self-hosting available",
    electric: "Self-host or Electric Cloud",
    feature: "Extra service to run",
    instant: "Hosted by default",
    powersync: "Cloud or self-hosted",
    strata: "None. Optional Redis for fan-out",
    zero: "Self-hosted zero-cache",
  },
  {
    convex: "Server-side mutation functions",
    electric: "Bring your own write API",
    feature: "Write path",
    instant: "Built in",
    powersync: "Bring your own upload handler",
    strata: "Built in: durable outbox, /sync/mutate",
    zero: "Custom mutators",
  },
  {
    convex: "Optimistic concurrency, transactional",
    electric: "Postgres replication stream",
    feature: "Ordering and conflicts",
    instant: "Server-authoritative",
    powersync: "Replication checkpoints",
    strata: "Server-sequenced log, field-level rebase",
    zero: "Server-authoritative, rebased",
  },
  {
    convex: "Bring your own CRDT",
    electric: "Bring your own CRDT",
    feature: "Collaborative text",
    instant: "Bring your own CRDT",
    powersync: "Bring your own CRDT",
    strata: "Yjs, built in",
    zero: "Bring your own CRDT",
  },
  {
    convex: "Bring your own",
    electric: "Bring your own",
    feature: "Undo and redo",
    instant: "Bring your own",
    powersync: "Bring your own",
    strata: "Built in, from transaction history",
    zero: "Bring your own",
  },
];

const columns = [
  { key: "strata", name: "Strata Sync" },
  { key: "zero", name: "Zero" },
  { key: "electric", name: "ElectricSQL" },
  { key: "convex", name: "Convex" },
  { key: "instant", name: "InstantDB" },
  { key: "powersync", name: "PowerSync" },
] as const;

const Page = () => (
  <GuideShell guide={guide}>
    <h2>The three questions that actually separate them</h2>
    <p>
      Feature lists make these projects look similar, because they all sync data
      to a client and keep it fresh. Three questions pull them apart, and the
      answers tend to decide the choice on their own.
    </p>
    <ul>
      <li>
        <strong>Does it own your database?</strong> Convex and InstantDB bring
        their own. Electric, Zero, PowerSync and Strata Sync read the database
        you already have.
      </li>
      <li>
        <strong>Does it add a process to operate?</strong> Zero runs zero-cache,
        Electric runs its sync service, PowerSync runs its service. Strata Sync
        registers routes on the Fastify app you already deploy.
      </li>
      <li>
        <strong>Do writes go through it, or through your own API?</strong>{" "}
        Electric deliberately leaves the write path to you. Convex, Zero and
        Strata Sync each ship one.
      </li>
    </ul>

    <h2>Side by side</h2>
    <div className="not-prose my-8 overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">
          Sync engines compared on data ownership, services to run, write path,
          conflict resolution, collaborative text and undo
        </caption>
        <thead>
          <tr className="border-border border-b">
            <th className="py-3 pr-4 font-medium" scope="col">
              &nbsp;
            </th>
            {columns.map((column) => (
              <th
                className="py-3 pr-4 font-medium"
                key={column.key}
                scope="col"
              >
                {column.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              className="border-border/60 border-b align-top"
              key={row.feature}
            >
              <th className="py-3 pr-4 font-medium" scope="row">
                {row.feature}
              </th>
              {columns.map((column) => (
                <td
                  className="py-3 pr-4 text-muted-foreground"
                  key={column.key}
                >
                  {row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <p className="text-muted-foreground text-sm">
      Other columns summarise each project&#8217;s documented default
      architecture as of September 2026. If one has moved on, open a pull
      request and it will be corrected.
    </p>

    <h2>Convex</h2>
    <p>
      Convex is the one that changes the shape of your backend rather than
      attaching to it. It brings a managed reactive database, queries that
      update automatically as underlying data changes, and mutations written as
      server-side functions with optimistic concurrency control and transaction
      atomicity. Self-hosting exists, but the cloud deployment is the default
      path.
    </p>
    <p>
      That is a genuine strength when you are starting fresh and would rather
      one product owned the database, the functions and the sync. It is the
      wrong fit when the Postgres already exists, has other consumers, and has
      to stay where it is. Strata Sync sits at the opposite end: it never owns
      your data, it reads the database you run.
    </p>

    <h2>Zero</h2>
    <p>
      Zero runs zero-cache beside your Postgres and gives you ZQL, a query
      language of its own, with server-authoritative ordering and rebasing on
      conflict. Queries are the primary abstraction and they are subscriptions,
      so they update as data changes.
    </p>
    <p>
      Pick Zero if you want to think in queries and are happy to operate the
      cache. Pick Strata Sync if you would rather declare model classes and not
      add a process. The{" "}
      <a href={`${siteConfig.links.docs}/comparisons/zero`}>
        detailed Zero comparison
      </a>{" "}
      goes further, including when Zero is the better answer.
    </p>

    <h2>ElectricSQL</h2>
    <p>
      Electric streams filtered subsets of Postgres, which it calls shapes, to
      clients in real time. Writes go through your existing backend API. That is
      a deliberate scoping decision and it keeps the system small and easy to
      reason about.
    </p>
    <p>
      It also means the durable outbox, retry, idempotency and conflict handling
      are yours to build. If you want the read path solved and are happy owning
      the write path, Electric is the cleanest option here.
    </p>

    <h2>InstantDB and PowerSync</h2>
    <p>
      InstantDB pairs a hosted database with a built-in write path, aimed at
      getting a collaborative app running quickly. PowerSync syncs an existing
      Postgres or MongoDB to on-device SQLite through sync rules and buckets,
      with strong React Native support, and is the most mobile-oriented of the
      group.
    </p>

    <h2>Where Strata Sync fits</h2>
    <p>
      It implements the architecture Linear described: one server, one monotonic
      counter, and a total order every client replays, with conflicts resolved
      per field rather than per record. It ships the parts that are usually left
      to you, including the outbox, rebase, sync groups, undo from transaction
      history, and Yjs documents for collaborative text. It runs inside your
      Fastify app against your Postgres, with no hosted dependency.
    </p>
    <p>
      The honest limits: it is one author plus contributors, in production on
      one product, and it is younger than Electric or Convex. If you want a
      vendor whose entire company is this, that is a real argument for the
      others.
    </p>
  </GuideShell>
);

export default Page;
