import type { Metadata } from "next";

import { GuideShell } from "@/components/guide-shell";
import { siteConfig } from "@/lib/config";
import { getGuide, guideUrl } from "@/lib/guides";

const guide = getGuide("strata-sync-vs-convex");

if (!guide) {
  throw new Error("Missing guide entry: strata-sync-vs-convex");
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
    <p>
      Both are worth using. They disagree about one thing, and almost everything
      else follows from it: who owns the database.
    </p>

    <h2>Who owns the data</h2>
    <p>
      Convex brings its own managed database. Your data lives inside it, and one
      product holds the data, runs the functions and pushes updates. Strata Sync
      owns nothing. <code>@stratasync/server</code> adds routes to the Fastify
      app you already deploy and writes its log into the Postgres you already
      run. Anything else reading that database keeps working.
    </p>
    <p>
      If you are starting fresh and want one product to own the backend, that is
      a real advantage and Convex is good at it. If the database already exists
      and has to stay yours, no feature list changes the answer.
    </p>

    <h2>How writes work</h2>
    <p>
      In Convex, writes are server functions: transactional, called from the
      client, with a natural home for validation. In Strata Sync the client has
      a durable outbox. A change applies at once and queues until the server
      confirms it through <code>/sync/mutate</code>, with idempotency keys so a
      retry never applies twice.
    </p>

    <h2>Where they agree</h2>
    <p>
      More than the framing suggests. Convex uses optimistic concurrency control
      with a strictly increasing sequence id. Strata Sync gives every change a
      monotonic <code>syncId</code> and has clients replay that order. Both are
      server-authoritative, and both let a client catch up by asking for
      everything after a number. Strata Sync also resolves conflicts per field,
      so two people editing different fields of one row never collide.
    </p>

    <h2>Collaborative text</h2>
    <p>
      Neither ships it in the core model, for the same reason: server ordering
      handles two people typing in one paragraph badly. Strata Sync includes Yjs
      documents and presence in{" "}
      <a href={`${siteConfig.links.docs}/packages/y-doc`}>
        <code>@stratasync/y-doc</code>
      </a>
      . With Convex you bring your own CRDT.
    </p>

    <h2>Choosing</h2>
    <ul>
      <li>
        <strong>Convex</strong> when you want one product to own the backend,
        you have no existing Postgres, and you want a company behind it.
      </li>
      <li>
        <strong>Strata Sync</strong> when the database must stay yours, you want
        Linear&#8217;s architecture, or you need undo and collaborative text
        without assembling them.
      </li>
    </ul>
    <p>
      Convex is a funded product with a team. Strata Sync is one author plus
      contributors, in production on one product, MIT licensed. That is a real
      argument for Convex if support matters more than owning the stack. For the
      wider field, see the{" "}
      <a href={`${siteConfig.url}/guides/sync-engine-comparison`}>
        sync engine comparison
      </a>
      .
    </p>
  </GuideShell>
);

export default Page;
