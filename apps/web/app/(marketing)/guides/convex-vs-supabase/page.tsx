import type { Metadata } from "next";

import { GuideShell } from "@/components/guide-shell";
import { siteConfig } from "@/lib/config";
import { getGuide, guideUrl } from "@/lib/guides";

const guide = getGuide("convex-vs-supabase");

if (!guide) {
  throw new Error("Missing guide entry: convex-vs-supabase");
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
      This one is not about Strata Sync. It is a comparison of two backends,
      written because the choice comes up constantly and most of the pages about
      it are trying to sell you one of them. The last section says where a sync
      engine fits, and you can stop before it.
    </p>

    <h2>The question underneath</h2>
    <p>
      Both give you a database, a way to write to it from a client, and
      authentication. The difference that determines everything else is whether
      you own the database.
    </p>
    <p>
      Convex brings its own. It is a managed reactive document store with a
      relational data model, and your data lives inside Convex. Supabase gives
      you a standard Postgres instance that happens to have auth, storage and a
      realtime feed attached. Anything that speaks Postgres can connect to it.
    </p>

    <h2>Queries and reactivity</h2>
    <p>
      Convex integrates the two. Queries are reactive by default: they re-run
      and push to connected clients when the underlying data changes, and you do
      not subscribe to anything separately. Writes are server-side mutation
      functions with optimistic concurrency control and transaction atomicity.
      It is a coherent model, and the coherence is the product.
    </p>
    <p>
      Supabase keeps them apart. You query Postgres however you like, and
      subscribe to Realtime separately when you want to know about changes. That
      is more wiring, and it is also easier to reason about, because nothing is
      re-running behind your back.
    </p>

    <h2>Neither gives you offline</h2>
    <p>
      This is the part both comparisons usually skip. Convex pushes to connected
      clients. Supabase pushes to connected clients. Neither keeps a replica on
      the device that you write to, neither queues writes made while offline,
      and neither reconciles those writes against what changed in the meantime.
    </p>
    <p>
      For most applications that is completely fine. If yours needs to work on a
      train, or needs reads that never wait, that gap is yours to fill either
      way, and the choice of backend does not close it.
    </p>

    <h2>Leaving</h2>
    <p>
      Supabase is the easier one to walk away from, because a standard Postgres
      is a standard Postgres. Convex data lives in Convex, so leaving means an
      export plus a rewrite of every server function you wrote against it.
    </p>
    <p>
      That is not a reason to avoid Convex. It is a cost worth pricing at the
      start rather than discovering in year three.
    </p>

    <h2>Choosing</h2>
    <ul>
      <li>
        <strong>Convex</strong> when you want one product to own the database,
        the functions and the reactivity, and you would rather have coherence
        than control.
      </li>
      <li>
        <strong>Supabase</strong> when you want a Postgres you own, other tools
        connecting to it, and the freedom to replace any one piece.
      </li>
    </ul>

    <h2>Where a sync engine fits</h2>
    <p>
      If you pick Supabase and later need the offline and instant-read behaviour
      neither backend ships, that is what a sync engine does, and Strata Sync
      runs on a Supabase Postgres without extensions or replication. There is a
      page on{" "}
      <a href={`${siteConfig.url}/guides/supabase-sync-engine`}>
        adding a sync engine to Supabase
      </a>{" "}
      covering what it takes, including the Node process you have to run.
    </p>
    <p>
      If you pick Convex,{" "}
      <a href={`${siteConfig.url}/guides/strata-sync-vs-convex`}>
        Strata Sync vs Convex
      </a>{" "}
      is the more relevant comparison, and it is honest about where the two
      architectures agree.
    </p>
  </GuideShell>
);

export default Page;
