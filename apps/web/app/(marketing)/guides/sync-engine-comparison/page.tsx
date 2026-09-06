import type { Metadata } from "next";

import { GuideShell } from "@/components/guide-shell";
import {
  H2,
  List,
  ListItem,
  P,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from "@/components/ui/typography";
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
    <H2>The three questions that actually separate them</H2>
    <P>
      Feature lists make these projects look similar, because they all sync data
      to a client and keep it fresh. Three questions pull them apart, and the
      answers tend to decide the choice on their own.
    </P>
    <List>
      <ListItem>
        <strong>Does it own your database?</strong> Convex and InstantDB bring
        their own. Electric, Zero, PowerSync and Strata Sync read the database
        you already have.
      </ListItem>
      <ListItem>
        <strong>Does it add a process to operate?</strong> Zero runs zero-cache,
        Electric runs its sync service, PowerSync runs its service. Strata Sync
        registers routes on the Fastify app you already deploy.
      </ListItem>
      <ListItem>
        <strong>Do writes go through it, or through your own API?</strong>{" "}
        Electric deliberately leaves the write path to you. Convex, Zero and
        Strata Sync each ship one.
      </ListItem>
    </List>

    <H2>Side by side</H2>
    <Table className="text-sm">
      <caption className="sr-only">
        Sync engines compared on data ownership, services to run, write path,
        conflict resolution, collaborative text and undo
      </caption>
      <Thead>
        <Tr>
          <Th scope="col">&nbsp;</Th>
          {columns.map((column) => (
            <Th key={column.key} scope="col">
              {column.name}
            </Th>
          ))}
        </Tr>
      </Thead>
      <Tbody>
        {rows.map((row) => (
          <Tr key={row.feature}>
            <Th scope="row">{row.feature}</Th>
            {columns.map((column) => (
              <Td key={column.key}>{row[column.key]}</Td>
            ))}
          </Tr>
        ))}
      </Tbody>
    </Table>
    <P className="text-muted-foreground text-sm">
      Other columns summarise each project&#8217;s documented default
      architecture as of September 2026. If one has moved on, open a pull
      request and it will be corrected.
    </P>

    <H2>Convex</H2>
    <P>
      Convex is the one that changes the shape of your backend rather than
      attaching to it. It brings a managed reactive database, queries that
      update automatically as underlying data changes, and mutations written as
      server-side functions with optimistic concurrency control and transaction
      atomicity. Self-hosting exists, but the cloud deployment is the default
      path.
    </P>
    <P>
      That is a genuine strength when you are starting fresh and would rather
      one product owned the database, the functions and the sync. It is the
      wrong fit when the Postgres already exists, has other consumers, and has
      to stay where it is. Strata Sync sits at the opposite end: it never owns
      your data, it reads the database you run.
    </P>

    <H2>Zero</H2>
    <P>
      Zero runs zero-cache beside your Postgres and gives you ZQL, a query
      language of its own, with server-authoritative ordering and rebasing on
      conflict. Queries are the primary abstraction and they are subscriptions,
      so they update as data changes.
    </P>
    <P>
      Pick Zero if you want to think in queries and are happy to operate the
      cache. Pick Strata Sync if you would rather declare model classes and not
      add a process. The{" "}
      <a href={`${siteConfig.url}/guides/strata-sync-vs-zero`}>
        detailed Zero comparison
      </a>{" "}
      goes further, including when Zero is the better answer.
    </P>

    <H2>ElectricSQL</H2>
    <P>
      Electric streams filtered subsets of Postgres, which it calls shapes, to
      clients in real time. Writes go through your existing backend API. That is
      a deliberate scoping decision and it keeps the system small and easy to
      reason about.
    </P>
    <P>
      It also means the durable outbox, retry, idempotency and conflict handling
      are yours to build. If you want the read path solved and are happy owning
      the write path, Electric is the cleanest option here.
    </P>

    <H2>InstantDB and PowerSync</H2>
    <P>
      InstantDB pairs a hosted database with a built-in write path, aimed at
      getting a collaborative app running quickly. PowerSync syncs an existing
      Postgres or MongoDB to on-device SQLite through sync rules and buckets,
      with strong React Native support, and is the most mobile-oriented of the
      group.
    </P>

    <H2>Where Strata Sync fits</H2>
    <P>
      It implements the architecture Linear described: one server, one monotonic
      counter, and a total order every client replays, with conflicts resolved
      per field rather than per record. It ships the parts that are usually left
      to you, including the outbox, rebase, sync groups, undo from transaction
      history, and Yjs documents for collaborative text. It runs inside your
      Fastify app against your Postgres, with no hosted dependency.
    </P>
    <P>
      The honest limits: it is one author plus contributors, in production on
      one product, and it is younger than Electric or Convex. If you want a
      vendor whose entire company is this, that is a real argument for the
      others.
    </P>
  </GuideShell>
);

export default Page;
