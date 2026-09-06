import type { Metadata } from "next";

import { GuideShell } from "@/components/guide-shell";
import { H2, InlineCode, P } from "@/components/ui/typography";
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
    <H2>What Realtime does, and where it stops</H2>
    <P>
      Supabase Realtime has three parts. Broadcast sends ephemeral messages
      between clients, Presence tracks who is connected, and Postgres Changes
      streams row-level changes out of your database as they commit. All three
      are useful and all three do what they say.
    </P>
    <P>
      What none of them do is hold state on the client. When a change arrives,
      it is your code that decides where to put it. When the connection drops,
      the messages that would have arrived are gone rather than queued. When the
      user edits something while offline, there is nowhere for that edit to live
      until the network returns, and nothing to reconcile it against when it
      does.
    </P>
    <P>
      That is the line between a live feed and a sync engine. Realtime gives you
      the push. The replica, the write queue and the reconciliation rule are the
      parts you build yourself, and they are most of the work.
    </P>

    <H2>What Strata Sync adds</H2>
    <P>
      Reads come from an IndexedDB replica, so screens render without a round
      trip. Writes apply to the local model immediately and sit in a durable
      outbox until the server confirms them, with idempotency keys so a retry
      never applies twice. On reconnect the client asks for everything after the
      sync id it last saw, rebases its queued writes on top, and drains them in
      order.
    </P>
    <P>
      Conflicts resolve per field rather than per record, so two people editing
      different columns of the same row never collide. Rich text uses Yjs
      documents instead, because a single server ordering handles two people
      typing in one paragraph badly.
    </P>

    <H2>It runs on your Supabase database as it is</H2>
    <P>
      The sync log is three ordinary Postgres tables. They use{" "}
      <InlineCode>bigserial</InlineCode>, <InlineCode>uuid</InlineCode>,{" "}
      <InlineCode>text</InlineCode>, <InlineCode>jsonb</InlineCode> and
      timestamps, with a couple of unique indexes. There are no extensions to
      install, no logical replication to configure, and no{" "}
      <InlineCode>LISTEN</InlineCode>/<InlineCode>NOTIFY</InlineCode>. Your
      existing schema is not touched, and anything else reading that database
      keeps working.
    </P>

    <H2>What you still have to run</H2>
    <P>
      A Node process. Strata Sync&#8217;s server is a set of Fastify routes, and
      Supabase does not host arbitrary Node servers: Edge Functions are Deno.
      You run that process wherever you already run one, then point it at your
      Supabase connection string.
    </P>
    <P>
      This is the honest cost of the approach, and it is worth saying plainly
      rather than burying. If the appeal of Supabase is that you do not operate
      a backend, adding a sync engine means you now operate one process.
    </P>

    <H2>Two things to get right</H2>
    <P>
      <strong>Connection pooling.</strong> Use the session-mode connection, or
      set <InlineCode>prepare: false</InlineCode> on postgres-js.
      Supabase&#8217;s pooler in transaction mode does not support prepared
      statements, which postgres-js uses by default. This is the standard
      requirement for that combination rather than anything specific to this
      library.
    </P>
    <P>
      <strong>Where authorisation lives.</strong> Strata Sync resolves sync
      groups server-side and authorises writes itself, connecting as an ordinary
      Postgres role. If you also use row level security on the same tables, pick
      which layer owns the rule. Running both and assuming they agree is how a
      permission bug gets shipped.
    </P>

    <H2>When not to bother</H2>
    <P>
      If your app is online-only, one user writes each record, and a spinner is
      acceptable, Realtime plus optimistic updates gets you most of the feel for
      none of the commitment. A sync engine is a data-model decision, not a
      dependency. The{" "}
      <a href={`${siteConfig.url}/guides/what-is-a-sync-engine`}>
        sync engine guide
      </a>{" "}
      goes through when the answer should be no.
    </P>
    <P>
      If you are still choosing a backend,{" "}
      <a href={`${siteConfig.url}/guides/convex-vs-supabase`}>
        Convex vs Supabase
      </a>{" "}
      covers that decision, and the{" "}
      <a href={`${siteConfig.links.docs}/quick-start`}>quick start</a> is five
      steps to a working client.
    </P>
  </GuideShell>
);

export default Page;
