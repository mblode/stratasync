import type { Metadata } from "next";

import { GuideShell } from "@/components/guide-shell";
import { H2, InlineCode, List, ListItem, P } from "@/components/ui/typography";
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
    <P>
      Convex describes what it does honestly, so this page does not need to
      argue with it. Both projects are worth using. They disagree about one
      thing, and almost everything else follows from it: who owns the database.
    </P>

    <H2>Who owns the data</H2>
    <P>
      Convex brings its own managed database. It is a reactive document store
      with a relational data model, and your application data lives inside it.
      That is the product: one place that holds the data, runs the functions and
      pushes updates to clients.
    </P>
    <P>
      Strata Sync owns nothing. <InlineCode>@stratasync/server</InlineCode>{" "}
      registers bootstrap, mutate and WebSocket routes on the Fastify app you
      already deploy, and writes its sync log into the Postgres you already run.
      If that database has a reporting pipeline, an admin tool or another
      service reading it, those keep working untouched.
    </P>
    <P>
      This is the decision. If you are starting fresh and would rather one
      product owned the backend, that is a real advantage and Convex is good at
      it. If the database already exists and has to stay yours, no amount of
      feature comparison changes the answer.
    </P>

    <H2>How writes work</H2>
    <P>
      In Convex you write mutations as server-side functions. The function is
      the unit: it runs on Convex, it is transactional, and the client calls it.
      That gives you a natural place to put validation and authorisation, and it
      means the client cannot write directly to the store.
    </P>
    <P>
      Strata Sync gives the client a durable outbox. You mutate a model locally,
      the change applies immediately, and it queues until the server confirms it
      through <InlineCode>/sync/mutate</InlineCode>, with idempotency keys so a
      retry never applies twice. Authorisation happens server-side against your
      configured models and sync groups.
    </P>

    <H2>Where they agree, which is more than it looks</H2>
    <P>
      It would be easy to frame these as opposites on conflict handling. They
      are not. Convex uses optimistic concurrency control with transaction
      atomicity, and a strictly increasing sequence identifier for iterating
      changes. Strata Sync assigns every change a monotonic{" "}
      <InlineCode>syncId</InlineCode> and has clients replay that total order.
    </P>
    <P>
      Both are therefore server-authoritative, and both let a client that has
      been away catch up by asking for everything after a number. Neither asks
      you to reason about CRDT merge semantics for ordinary records. If you like
      the guarantees of one, you will probably like the other&#8217;s.
    </P>
    <P>
      The difference underneath is scope. Strata Sync resolves conflicts per
      field rather than per record, so two people editing different fields of
      the same row never collide.
    </P>

    <H2>Collaborative text</H2>
    <P>
      Neither ships collaborative text editing as part of the core model, for
      the same reason: a single server ordering handles records well and handles
      two people typing in one paragraph badly.
    </P>
    <P>
      Strata Sync includes Yjs CRDT documents and presence through{" "}
      <a href={`${siteConfig.links.docs}/packages/y-doc`}>
        <InlineCode>@stratasync/y-doc</InlineCode>
      </a>
      , so rich text is a package rather than a project. With Convex you bring
      your own CRDT layer.
    </P>

    <H2>Choosing</H2>
    <List>
      <ListItem>
        <strong>Choose Convex</strong> when you want one product to own the
        database, the functions and the sync, you are starting without an
        existing Postgres, and you want a company whose whole business is this.
      </ListItem>
      <ListItem>
        <strong>Choose Strata Sync</strong> when the database is already yours
        and must stay that way, you want Linear&#8217;s architecture
        specifically, or you need built-in undo and collaborative text without
        assembling them.
      </ListItem>
    </List>
    <P>
      Being straight about the asymmetry: Convex is a funded product with a team
      behind it. Strata Sync is one author plus contributors, in production on
      one product, MIT licensed. That is a real argument for Convex if support
      matters more than owning the stack.
    </P>
    <P>
      For the wider field, including ElectricSQL, InstantDB and PowerSync, see
      the{" "}
      <a href={`${siteConfig.url}/guides/sync-engine-comparison`}>
        sync engine comparison
      </a>
      . If you are still deciding whether you need a sync engine at all, start
      with{" "}
      <a href={`${siteConfig.url}/guides/what-is-a-sync-engine`}>
        what a sync engine is
      </a>
      .
    </P>
  </GuideShell>
);

export default Page;
