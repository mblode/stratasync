import type { Metadata } from "next";

import { GuideShell } from "@/components/guide-shell";
import { siteConfig } from "@/lib/config";
import { getGuide, guideUrl } from "@/lib/guides";

const guide = getGuide("strata-sync-vs-zero");

if (!guide) {
  throw new Error("Missing guide entry: strata-sync-vs-zero");
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
      Both keep a local replica in the browser and reconcile it against a
      server, and both are server-authoritative over your own Postgres. They
      disagree about where queries run, how you describe your data, and what you
      have to deploy.
    </p>

    <h2>The short answer</h2>
    <p>
      Pick <strong>Zero</strong> if you want reactive queries in a purpose-built
      query language, evaluated against a server-side cache, and you are willing
      to run <code>zero-cache</code> next to your database.
    </p>
    <p>
      Pick <strong>Strata Sync</strong> if you want Linear&#8217;s architecture:
      model classes and decorators in TypeScript, a server-sequenced log, and a
      sync server that is a set of routes inside your existing Fastify app
      rather than a separate process.
    </p>

    <h2>The deployment unit</h2>
    <p>
      Zero introduces a process. <code>zero-cache</code> sits between your
      client and Postgres, holds the replica the server reasons about, and has
      to be run, scaled and monitored like any other service.
    </p>
    <p>
      Strata Sync introduces routes. <code>@stratasync/server</code> registers{" "}
      <code>/sync/bootstrap</code>, <code>/sync/mutate</code> and a WebSocket on
      the Fastify app you already deploy, and reads the same Postgres you
      already run. Redis is optional, and only for fan-out across instances.
    </p>
    <p>
      This is the difference most likely to decide it, and it cuts both ways: a
      separate cache is also a separate thing you can scale independently.
    </p>

    <h2>How you ask for data</h2>
    <p>
      Zero ships ZQL, a query language of its own, and queries are subscriptions
      that update as the underlying data changes.
    </p>
    <p>
      Strata Sync follows Linear: you declare model classes with{" "}
      <code>@ClientModel</code> and <code>@Property</code>, and read them back
      through typed queries and React hooks. Reads hit the local replica, so
      they are synchronous once a model is loaded. There is no new query
      language to learn, and no query planner between you and your data.
    </p>

    <h2>Ordering and conflicts</h2>
    <p>
      Both are server-authoritative and both rebase, so neither asks you to
      reason about CRDT merge semantics for records.
    </p>
    <p>
      Strata Sync&#8217;s ordering is the piece it takes most directly from
      Linear: one monotonic counter, one total order, and a client that catches
      up after a week offline by asking for everything after a single integer.
      Conflicts resolve per field rather than per record, so two people editing
      different fields of the same row do not collide. See{" "}
      <a href={`${siteConfig.links.docs}/architecture/sync-protocol`}>
        the sync protocol
      </a>{" "}
      and{" "}
      <a href={`${siteConfig.links.docs}/architecture/linear-sync-engine`}>
        Linear&#8217;s sync engine, open-sourced
      </a>
      .
    </p>

    <h2>Text editing</h2>
    <p>
      Server ordering handles records well and text badly. Strata Sync uses Yjs
      CRDTs for rich text and ships presence with it, so collaborative editing
      is a package rather than a project. With Zero you bring your own CRDT
      layer.
    </p>

    <h2>When to pick Zero instead</h2>
    <ul>
      <li>You want queries as the primary abstraction and you like ZQL.</li>
      <li>
        You are happy to run and operate <code>zero-cache</code>.
      </li>
      <li>
        Your data model is relational rather than object-graph shaped, and you
        would rather write queries than declare model classes.
      </li>
      <li>
        You want the backing of a team whose whole product this is. Strata Sync
        is one author plus contributors, in production on one product.
      </li>
    </ul>
    <p>
      Sync engines are a real commitment, so read both sets of docs before
      choosing. If Linear&#8217;s architecture is the thing you actually want,
      that is what this project implements. For the wider field see the{" "}
      <a href={`${siteConfig.url}/guides/sync-engine-comparison`}>
        sync engine comparison
      </a>
      .
    </p>
  </GuideShell>
);

export default Page;
