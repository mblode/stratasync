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
      This page is not about Strata Sync until the last section. It is a
      comparison of two backends, because most pages on this choice are selling
      one of them.
    </p>

    <h2>Who owns the database</h2>
    <p>
      Both give you a database, a way to write to it from a client, and auth.
      The difference that decides everything else is ownership. Convex brings
      its own managed reactive database, and your data lives inside it. Supabase
      gives you a standard Postgres with auth, storage and a realtime feed
      attached. Anything that speaks Postgres can connect.
    </p>

    <h2>Queries and reactivity</h2>
    <p>
      Convex integrates them. Queries re-run and push to clients when data
      changes, and writes are server functions with optimistic concurrency
      control and transaction atomicity. Coherent, and the coherence is the
      product.
    </p>
    <p>
      Supabase keeps them apart. You query Postgres however you like and
      subscribe to Realtime separately. More wiring, and easier to reason about,
      because nothing re-runs behind your back.
    </p>

    <h2>Neither gives you offline</h2>
    <p>
      Both push to connected clients. Neither keeps a copy on the device that
      you write to, queues writes made offline, or reconciles them later. For
      most apps that is fine. If yours has to work on a train, the gap is yours
      to fill either way.
    </p>

    <h2>Leaving</h2>
    <p>
      Supabase is easier to walk away from, because a standard Postgres is a
      standard Postgres. Leaving Convex means an export plus a rewrite of every
      server function. Not a reason to avoid it. A cost to price at the start.
    </p>

    <h2>Choosing</h2>
    <ul>
      <li>
        <strong>Convex</strong> when you want one product to own the database,
        the functions and the reactivity.
      </li>
      <li>
        <strong>Supabase</strong> when you want a Postgres you own and the
        freedom to replace any piece.
      </li>
    </ul>

    <h2>Where a sync engine fits</h2>
    <p>
      If you pick Supabase and later need offline and instant reads, that is
      what a sync engine does, and Strata Sync runs on a Supabase Postgres
      without extensions. See{" "}
      <a href={`${siteConfig.url}/guides/supabase-sync-engine`}>
        adding a sync engine to Supabase
      </a>
      . If you pick Convex,{" "}
      <a href={`${siteConfig.url}/guides/strata-sync-vs-convex`}>
        Strata Sync vs Convex
      </a>{" "}
      is the relevant comparison.
    </p>
  </GuideShell>
);

export default Page;
