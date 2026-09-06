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
    <h2>The short answer</h2>
    <p>
      Pick <strong>Zero</strong> if you want reactive queries in a purpose-built
      query language and you are willing to run <code>zero-cache</code> next to
      your database.
    </p>
    <p>
      Pick <strong>Strata Sync</strong> if you want Linear&#8217;s architecture:
      model classes in TypeScript, a server-sequenced log, and a sync server
      that is a set of routes in your own Fastify app.
    </p>

    <h2>What you deploy</h2>
    <p>
      Zero adds a process. <code>zero-cache</code> sits between your client and
      Postgres and has to be run, scaled and monitored. Strata Sync adds routes
      to the app you already deploy, with Redis optional for fan-out. This is
      the difference most likely to decide it, and it cuts both ways: a separate
      cache is also a thing you can scale on its own.
    </p>

    <h2>How you ask for data</h2>
    <p>
      Zero ships ZQL, and queries are subscriptions that update as data changes.
      Strata Sync has you declare model classes with <code>@ClientModel</code>{" "}
      and <code>@Property</code> and read them through typed queries and hooks.
      Reads hit the local copy, so they are synchronous once a model is loaded,
      and there is no new query language.
    </p>

    <h2>Conflicts and text</h2>
    <p>
      Both are server-authoritative and both rebase. Strata Sync resolves per
      field, so two people editing different fields of one row never collide,
      and a client catches up after a week offline by asking for everything
      after one integer. Rich text uses Yjs, which ships in the box. With Zero
      you bring your own CRDT. See{" "}
      <a href={`${siteConfig.links.docs}/architecture/sync-protocol`}>
        the sync protocol
      </a>{" "}
      and{" "}
      <a href={`${siteConfig.url}/guides/linear-sync-engine`}>
        Linear&#8217;s sync engine, open-sourced
      </a>
      .
    </p>

    <h2>When to pick Zero</h2>
    <ul>
      <li>You want queries as the main abstraction and you like ZQL.</li>
      <li>
        You are happy to operate <code>zero-cache</code>.
      </li>
      <li>You would rather write queries than declare model classes.</li>
      <li>
        You want a team whose whole product this is. Strata Sync is one author
        plus contributors, in production on one product.
      </li>
    </ul>
    <p>
      Sync engines are a real commitment, so read both sets of docs before
      choosing. For the wider field, see the{" "}
      <a href={`${siteConfig.url}/guides/sync-engine-comparison`}>
        sync engine comparison
      </a>
      .
    </p>
  </GuideShell>
);

export default Page;
