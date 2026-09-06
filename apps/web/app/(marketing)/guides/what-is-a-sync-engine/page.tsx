import type { Metadata } from "next";

import { GuideShell } from "@/components/guide-shell";
import { siteConfig } from "@/lib/config";
import { getGuide, guideUrl } from "@/lib/guides";

const guide = getGuide("what-is-a-sync-engine");

if (!guide) {
  throw new Error("Missing guide entry: what-is-a-sync-engine");
}

export const metadata: Metadata = {
  alternates: { canonical: guideUrl(guide.slug) },
  description: guide.description,
  // `openGraph` is declared here, so every field the layout supplied has to be
  // restated: Next replaces object metadata wholesale rather than merging it.
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

const Page = () => (
  <GuideShell guide={guide}>
    <h2>The mechanism</h2>
    <p>
      Most applications ask the server for data when a screen opens and show a
      spinner until it arrives. Every read is a round trip, every write waits
      for confirmation, and a dropped connection is an error state. A sync
      engine inverts that. The client holds a replica of the data it is allowed
      to see, the interface reads and writes the replica, and a background
      process reconciles it with the server.
    </p>
    <p>
      Two pieces do all the work. The first is the local replica, usually
      IndexedDB in a browser or SQLite on a device. The second is the
      reconciliation rule that decides what happens when your copy and the
      server&#8217;s copy disagree. Everything else a sync engine offers,
      including real-time updates and offline support, falls out of those two.
    </p>

    <h2>Why teams reach for one</h2>
    <p>
      The usual reason given is real-time collaboration, but that is a side
      effect. The reasons that survive contact with a product are latency and
      offline. Reading from a local replica returns in microseconds, so
      navigation stops having a loading state at all. Writing to it means a
      commuter on a train can keep working through a tunnel and have the edits
      land when signal returns.
    </p>
    <p>
      Real-time comes free because the machinery that pushes other
      clients&#8217; changes to you is the same machinery that catches you up
      after a disconnect. That is why the three keep getting conflated.
    </p>

    <h2>The two families of reconciliation</h2>
    <p>
      Conflict resolution splits into two approaches, and the choice shapes
      everything above it.
    </p>
    <p>
      <strong>Conflict-free replicated data types</strong> encode the merge into
      the data structure itself. Two clients that see the same set of edits in
      any order arrive at the same state, with no coordinator. The cost is
      metadata attached to every value, and awkwardness once you need partial
      replication or per-row permissions, because a client that only holds part
      of the document is a harder thing to reason about.
    </p>
    <p>
      <strong>A server-ordered log</strong> gives one server the final say. It
      assigns every change a monotonically increasing number, and clients replay
      that order. There is no merge function for records: the server decided.
      Clients rebase their pending writes on top of whatever arrived while they
      were behind. Partial replication and permissions come from the same
      mechanism, because a client only ever receives the groups it subscribes
      to. This is the approach{" "}
      <a href="https://linear.app/now/scaling-the-linear-sync-engine">
        Linear described publicly
      </a>{" "}
      and the one <a href={siteConfig.links.docs}>Strata Sync</a> implements.
    </p>
    <p>
      Text is the exception either way. Two people typing in one paragraph is
      exactly the case a single ordering handles badly, which is why engines
      built on a server-ordered log still reach for a CRDT for rich text.
    </p>

    <h2>When you should not use one</h2>
    <p>
      A sync engine is a data-model commitment, not a library you drop in behind
      an existing fetch layer. Skip it when:
    </p>
    <ul>
      <li>
        One user writes each record and nobody else reads it concurrently. A
        refetch resolves every conflict you will ever have.
      </li>
      <li>
        The dataset per user is large and mostly cold. Replicating it to keep a
        rarely-visited screen fast is a poor trade.
      </li>
      <li>
        Your data is derived server-side, from a search index or a report
        pipeline. There is nothing meaningful to write back.
      </li>
      <li>
        The network is reliable and the interface tolerates a spinner.
        Optimistic updates on top of ordinary requests get most of the feel for
        a fraction of the commitment.
      </li>
    </ul>
    <p>
      The real cost is ongoing. Every synced type needs a stable identity, a
      defined conflict rule, and a decision about who may see it. The local
      store becomes a schema you have to migrate. Those obligations do not go
      away, so the benefit has to be worth carrying them.
    </p>

    <h2>What to look at next</h2>
    <p>
      If the server-ordered approach sounds right, the{" "}
      <a href={`${siteConfig.links.docs}/architecture/sync-protocol`}>
        sync protocol
      </a>{" "}
      page walks through bootstrap, deltas and the mutate path concretely. If
      you are still choosing between projects, the{" "}
      <a href={`${siteConfig.url}/guides/sync-engine-comparison`}>
        comparison guide
      </a>{" "}
      covers Zero, ElectricSQL, Convex, InstantDB and PowerSync on the
      dimensions that actually differ.
    </p>
  </GuideShell>
);

export default Page;
