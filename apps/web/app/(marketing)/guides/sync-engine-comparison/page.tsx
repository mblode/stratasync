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

/** Each project's documented default architecture, as of September 2026. */
const rows = [
  {
    convex: "Convex's database",
    electric: "Your Postgres",
    feature: "Your data",
    instant: "Instant's database",
    powersync: "Your database",
    strata: "Your Postgres, in your app",
    zero: "Your Postgres",
  },
  {
    convex: "Convex cloud",
    electric: "Electric",
    feature: "Extra service",
    instant: "Instant cloud",
    powersync: "PowerSync",
    strata: "None",
    zero: "zero-cache",
  },
  {
    convex: "Server functions",
    electric: "Your own API",
    feature: "Writes",
    instant: "Built in",
    powersync: "Your own handler",
    strata: "Built in",
    zero: "Custom mutators",
  },
  {
    convex: "Transactional",
    electric: "Replication stream",
    feature: "Conflicts",
    instant: "Server-authoritative",
    powersync: "Checkpoints",
    strata: "Server log, per-field rebase",
    zero: "Server-authoritative",
  },
  {
    convex: "Bring your own",
    electric: "Bring your own",
    feature: "Text and undo",
    instant: "Bring your own",
    powersync: "Bring your own",
    strata: "Both built in",
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
    <h2>Three questions that separate them</h2>
    <ul>
      <li>
        <strong>Does it own your database?</strong> Convex and InstantDB bring
        their own. Electric, Zero, PowerSync and Strata Sync use the one you
        have.
      </li>
      <li>
        <strong>Does it add a process to run?</strong> Zero, Electric and
        PowerSync each run a service. Strata Sync adds routes to your app.
      </li>
      <li>
        <strong>Do writes go through it?</strong> Electric leaves the write path
        to you. Convex, Zero and Strata Sync ship one.
      </li>
    </ul>

    <h2>Side by side</h2>
    <table className="text-sm">
      <caption className="sr-only">
        Sync engines compared on data, extra services, writes, conflicts, and
        text and undo
      </caption>
      <thead>
        <tr>
          <th scope="col">&nbsp;</th>
          {columns.map((column) => (
            <th key={column.key} scope="col">
              {column.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.feature}>
            <th scope="row">{row.feature}</th>
            {columns.map((column) => (
              <td key={column.key}>{row[column.key]}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
    <p className="text-muted-foreground text-sm">
      Columns describe each project&#8217;s documented defaults as of September
      2026. If one has moved on, open a pull request.
    </p>

    <h2>Convex</h2>
    <p>
      The one that changes the shape of your backend rather than attaching to
      it: a managed reactive database, reactive queries and server functions. A
      strength when you are starting fresh. The wrong fit when the Postgres
      already exists and has to stay where it is.
    </p>

    <h2>Zero</h2>
    <p>
      Runs zero-cache beside your Postgres and gives you ZQL, with
      server-authoritative rebasing. Pick it to think in queries. Pick Strata
      Sync to declare model classes and not add a process.{" "}
      <a href={`${siteConfig.url}/guides/strata-sync-vs-zero`}>
        The detailed comparison
      </a>{" "}
      says when Zero is the better answer.
    </p>

    <h2>ElectricSQL</h2>
    <p>
      Streams filtered Postgres data to clients and deliberately leaves writes
      to your API, which keeps it small. The outbox, retries and conflict
      handling are yours to build.
    </p>

    <h2>InstantDB and PowerSync</h2>
    <p>
      InstantDB pairs a hosted database with a built-in write path for getting a
      collaborative app up fast. PowerSync syncs an existing Postgres or MongoDB
      to on-device SQLite, with strong React Native support, and is the most
      mobile-oriented of the group.
    </p>

    <h2>Where Strata Sync fits</h2>
    <p>
      It implements the architecture Linear described: one server, one counter,
      one order every client replays, with conflicts resolved per field. It
      ships the parts usually left to you, including the outbox, rebase, sync
      groups, undo and Yjs text, and runs inside your Fastify app against your
      Postgres. It is younger than Electric or Convex and built by one author
      plus contributors. If you want a vendor whose whole company is this, that
      is a real argument for the others.
    </p>
  </GuideShell>
);

export default Page;
