import type { Metadata } from "next";

import { GuideShell } from "@/components/guide-shell";
import { siteConfig } from "@/lib/config";
import { getGuide, guideUrl } from "@/lib/guides";

const guide = getGuide("supabase-sync-engine");

if (!guide) {
  throw new Error("Missing guide entry: supabase-sync-engine");
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
    <h2>Where Realtime stops</h2>
    <p>
      Supabase Realtime has three parts. Broadcast sends messages between
      clients, Presence tracks who is online, and Postgres Changes streams row
      changes out of your database as they commit. All three do what they say.
    </p>
    <p>
      None of them hold state on the device. When the connection drops, the
      changes you missed are gone rather than queued. When someone edits
      offline, there is nowhere for the edit to live and nothing to reconcile it
      against later. Realtime is the push. The local copy, the write queue and
      the conflict rule are the rest of the work.
    </p>

    <h2>What Strata Sync adds</h2>
    <p>
      Reads come from an IndexedDB copy, so screens render without a round trip.
      Writes apply at once and wait in a durable outbox until the server
      confirms them, with idempotency keys so a retry never applies twice. On
      reconnect the client asks for everything after the last sync id it saw and
      rebases its queued writes on top. Conflicts resolve per field, and rich
      text uses Yjs.
    </p>

    <h2>It runs on your Supabase database as it is</h2>
    <p>
      The sync log is three plain Postgres tables using <code>bigserial</code>,{" "}
      <code>uuid</code>, <code>text</code>, <code>jsonb</code> and timestamps.
      No extensions, no logical replication, no <code>LISTEN</code>/
      <code>NOTIFY</code>. Your existing schema is untouched.
    </p>

    <h2>What you still have to run</h2>
    <p>
      A Node process. The server is a set of Fastify routes, and Supabase Edge
      Functions are Deno. Run it wherever you already run one and point it at
      your Supabase connection string. If the appeal of Supabase is not
      operating a backend, this is the cost: you now operate one process.
    </p>

    <h2>Two things to get right</h2>
    <p>
      <strong>Pooling.</strong> Use the session-mode connection, or set{" "}
      <code>prepare: false</code> on postgres-js. The pooler in transaction mode
      does not support prepared statements.
    </p>
    <p>
      <strong>Authorisation.</strong> Strata Sync resolves sync groups
      server-side and authorises writes itself. If you also use row level
      security on the same tables, decide which layer owns the rule rather than
      running both and hoping they agree.
    </p>

    <h2>When not to bother</h2>
    <p>
      If your app is online-only and a spinner is fine, Realtime plus optimistic
      updates gets you most of the feel for none of the commitment.{" "}
      <a href={`${siteConfig.url}/guides/what-is-a-sync-engine`}>
        What a sync engine is
      </a>{" "}
      covers when the answer should be no. Still choosing a backend?{" "}
      <a href={`${siteConfig.url}/guides/convex-vs-supabase`}>
        Convex vs Supabase
      </a>
      . Ready to build? The{" "}
      <a href={`${siteConfig.links.docs}/quick-start`}>quick start</a> is five
      steps.
    </p>
  </GuideShell>
);

export default Page;
