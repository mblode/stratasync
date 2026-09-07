import type { Metadata } from "next";

import { GuideShell } from "@/components/guide-shell";
import { howItWorks, siteConfig } from "@/lib/config";
import { getGuide, guideUrl } from "@/lib/guides";

const guide = getGuide("what-is-a-sync-engine");

if (!guide) {
  throw new Error("Missing guide entry: what-is-a-sync-engine");
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

const Page = () => (
  <GuideShell guide={guide}>
    <h2>How it works</h2>
    <p>
      Most apps fetch data when a screen opens and show a spinner until it
      arrives. Every read is a round trip, and a dropped connection is an error.
      A sync engine flips that. The device holds a copy of the data, the
      interface reads and writes that copy, and a background process reconciles
      it with the server.
    </p>
    <p>
      Two pieces do the work: the local copy, usually IndexedDB or SQLite, and
      the rule for what happens when your copy and the server&#8217;s disagree.
      Offline support and real-time updates both fall out of those two.
    </p>

    <h2>Why teams want one</h2>
    <p>
      Not for real-time, though that comes free. For speed and for offline.
      Reading from a local copy takes microseconds, so screens stop having a
      loading state. Writing to it means someone on a train keeps working
      through the tunnel and their edits land when signal returns.
    </p>

    <h2>Two ways to resolve conflicts</h2>
    <p>
      <strong>CRDTs</strong> build the merge into the data itself. Clients that
      see the same edits in any order reach the same state, with no coordinator.
      The cost is metadata on every value, and awkwardness once you need partial
      replication or per-row permissions.
    </p>
    <p>
      <strong>A server-ordered log</strong> gives one server the final say. It
      numbers every change, clients replay that order, and pending writes are
      rebased on top of whatever arrived while they were behind. Permissions and
      partial replication come from the same mechanism. This is what{" "}
      <a href="https://linear.app/now/scaling-the-linear-sync-engine">
        Linear described
      </a>{" "}
      and what <a href={siteConfig.links.docs}>Strata Sync</a> implements.
    </p>
    <p>
      Text is the exception. Two people typing in one paragraph is the case a
      single ordering handles badly, so even log-based engines use a CRDT for
      rich text.
    </p>

    <h2>When you should not use one</h2>
    <ul>
      <li>
        One person writes each record and nobody else reads it at the same time.
      </li>
      <li>The data per user is large and mostly cold.</li>
      <li>Your data is computed server-side and nothing is written back.</li>
      <li>The network is reliable and a spinner is acceptable.</li>
    </ul>
    <p>
      A sync engine is a data-model decision, not a dependency. Every synced
      type needs a stable id, a conflict rule and a decision about who can see
      it, and the local store becomes a schema you migrate. Those costs do not
      go away, so the benefit has to earn them.
    </p>

    <h2>Next</h2>
    <p>
      To see the mechanism rather than read about it,{" "}
      <a href={howItWorks.url}>how a sync engine works</a> builds one from a
      single checkbox across ten figures you operate yourself.
    </p>
    <p>
      If the server-ordered approach sounds right, read{" "}
      <a href={`${siteConfig.links.docs}/architecture/sync-protocol`}>
        the sync protocol
      </a>
      . If you are choosing between projects, the{" "}
      <a href={`${siteConfig.url}/guides/sync-engine-comparison`}>
        comparison guide
      </a>{" "}
      covers Zero, ElectricSQL, Convex, InstantDB and PowerSync.
    </p>
  </GuideShell>
);

export default Page;
