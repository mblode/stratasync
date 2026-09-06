import type { Metadata } from "next";

import { GuideShell } from "@/components/guide-shell";
import { siteConfig } from "@/lib/config";
import { getGuide, guideUrl } from "@/lib/guides";

const guide = getGuide("linear-sync-engine");

if (!guide) {
  throw new Error("Missing guide entry: linear-sync-engine");
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

const { docs } = siteConfig.links;

const Page = () => (
  <GuideShell guide={guide}>
    <p>
      Linear&#8217;s engineers described their sync engine in talks and posts
      but never released the code. The{" "}
      <a href={siteConfig.links.linearReference}>reverse-engineering notes</a>{" "}
      wrote it down part by part. This page maps each part onto the module here
      that implements it. Strata Sync is a clean-room implementation: no Linear
      code, and Linear is not affiliated with the project.
    </p>

    <h2>Why this design</h2>
    <p>
      Most local-first engines use CRDTs, which merge without a coordinator but
      carry metadata on every value and get awkward with partial replication and
      per-row permissions. Linear went the other way: one server, one counter,
      one order every client replays. Ordering is decided in one place,
      permissions fall out of the same mechanism, and a client that was offline
      for a week catches up by asking for everything after a single integer.
      Text is the exception, and uses Yjs CRDTs.
    </p>

    <h2>The mapping</h2>

    <h3>Models</h3>
    <table>
      <thead>
        <tr>
          <th scope="col">Linear</th>
          <th scope="col">Strata Sync</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Decorators register models at startup</td>
          <td>
            <code>ModelRegistry</code>, filled by <code>@ClientModel</code> and
            the property decorators
          </td>
        </tr>
        <tr>
          <td>Load strategies</td>
          <td>
            <code>loadStrategy</code>: instant, lazy, partial,
            explicitlyRequested or local
          </td>
        </tr>
        <tr>
          <td>A reference holds an id and a resolved model</td>
          <td>
            <code>@Reference</code> holds the key. Collections hydrate on access
          </td>
        </tr>
        <tr>
          <td>A schema hash triggers migration</td>
          <td>
            <code>computeSchemaHash()</code>. A mismatch re-bootstraps
          </td>
        </tr>
      </tbody>
    </table>
    <p>
      Registration happens at import time, so a model file has to be imported
      for its models to exist. See{" "}
      <a href={`${docs}/packages/core/models`}>Models</a> and{" "}
      <a href={`${docs}/packages/core/schema`}>Schema</a>.
    </p>

    <h3>The object pool</h3>
    <p>
      Linear keeps one object per id in a <code>modelLookup</code> map, so every
      reference is the same instance. Strata Sync calls this the identity map,
      bounds it with <code>identityMapMaxSize</code>, and emits{" "}
      <code>modelChange</code> on eviction so hooks re-hydrate instead of
      reading a stale object.
    </p>

    <h3>Bootstrap and the sync id</h3>
    <table>
      <thead>
        <tr>
          <th scope="col">Linear</th>
          <th scope="col">Strata Sync</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <code>lastSyncId</code> orders every change
          </td>
          <td>
            <code>SyncId</code>, a string so it can grow past 2^53
          </td>
        </tr>
        <tr>
          <td>Full, partial or local bootstrap</td>
          <td>
            <code>bootstrapMode</code>: auto, full or local
          </td>
        </tr>
        <tr>
          <td>Streamed as newline-delimited JSON</td>
          <td>
            NDJSON from <code>/sync/bootstrap</code>
          </td>
        </tr>
        <tr>
          <td>
            Only <code>instant</code> models load at bootstrap
          </td>
          <td>Same. The rest load on first access</td>
        </tr>
      </tbody>
    </table>

    <h3>Partial indexes</h3>
    <p>
      Linear names a subset of a model by an index key, records which subsets it
      has already fetched, and batches requests so nothing is fetched twice.
      Strata Sync keeps that shape: <code>hasPartialIndex</code> and{" "}
      <code>setPartialIndex</code> on the storage adapter,{" "}
      <code>/sync/batch</code> for the fetch, and de-duplication of in-flight
      requests. Coverage is recorded only once a fetch succeeds, so a cancelled
      load never pretends the data is local. See{" "}
      <a href={`${docs}/guides/load-strategies`}>Load strategies</a>.
    </p>

    <h3>The transaction queue</h3>
    <table>
      <thead>
        <tr>
          <th scope="col">Linear</th>
          <th scope="col">Strata Sync</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Create, update, delete, archive, unarchive</td>
          <td>
            The same five, as <code>I</code>, <code>U</code>, <code>D</code>,{" "}
            <code>A</code>, <code>V</code>
          </td>
        </tr>
        <tr>
          <td>Updates apply in memory first</td>
          <td>Same. The outbox entry is what reaches the server</td>
        </tr>
        <tr>
          <td>Queue states</td>
          <td>
            <code>queued -&gt; sent -&gt; awaitingSync -&gt; completed</code>
          </td>
        </tr>
        <tr>
          <td>Persisted so a restart replays them</td>
          <td>A durable outbox</td>
        </tr>
        <tr>
          <td>Idempotency left to you</td>
          <td>
            <code>clientId + clientTxId</code>. A retry cannot apply twice
          </td>
        </tr>
      </tbody>
    </table>
    <p>
      One deliberate difference: Strata Sync writes optimistic state to memory
      but not to storage, so a reload before confirmation replays the outbox
      rather than reading an unconfirmed row.
    </p>

    <h3>Deltas and rebase</h3>
    <p>
      Sync actions arrive as <code>I</code>, <code>U</code>, <code>D</code>,{" "}
      <code>A</code>, <code>V</code>, plus <code>C</code> for coverage and{" "}
      <code>G</code> for a group change. Applying a packet means: handle group
      changes, write the rows, cancel any in-flight create whose model just
      arrived, rebase the rest of the outbox, then advance{" "}
      <code>lastSyncId</code>.
    </p>
    <p>
      Rebase is field-level by default, so two clients editing different fields
      of one row never conflict. <code>rebaseStrategy</code> picks what happens
      when they edit the same one: <code>server-wins</code> (default),{" "}
      <code>client-wins</code> or <code>merge</code>. See{" "}
      <a href={`${docs}/guides/conflict-resolution`}>Conflict resolution</a>.
    </p>

    <h3>Sync groups</h3>
    <p>
      Groups are the permission boundary. A client receives deltas only for the
      groups it subscribes to, and <code>auth.resolveGroups</code> decides those
      per request. Membership changes ship as durable <code>G</code> actions, so
      a user added to a team while offline still learns about it on the next
      catch-up, and a group action forces a re-bootstrap that the server filters
      on current membership.
    </p>

    <h3>Undo</h3>
    <p>
      Every mutation records its inverse. <code>client.undo()</code> sends it as
      an ordinary transaction, so other clients see a normal update.{" "}
      <code>runAsUndoGroup()</code> collapses several mutations into one step,
      and a server rejection drops the entry from both stacks.
    </p>

    <h2>What Strata Sync adds</h2>
    <ul>
      <li>
        <strong>Collaborative text.</strong> Yjs documents and presence in{" "}
        <code>@stratasync/y-doc</code>. See{" "}
        <a href={`${docs}/guides/collaborative-editing`}>
          Collaborative editing
        </a>
        .
      </li>
      <li>
        <strong>Swappable adapters.</strong> Storage, transport and reactivity
        are separate packages, so the core runs in Node with no browser.
      </li>
      <li>
        <strong>A server you own.</strong> <code>@stratasync/server</code>{" "}
        registers the routes on your Fastify app and stores the log in your
        Postgres. Redis is optional.
      </li>
    </ul>
    <p>
      For the wire protocol, read{" "}
      <a href={`${docs}/architecture/sync-protocol`}>the sync protocol</a>.
      Still deciding whether you need any of this?{" "}
      <a href={`${siteConfig.url}/guides/what-is-a-sync-engine`}>
        What a sync engine is
      </a>{" "}
      covers when the answer is no.
    </p>
  </GuideShell>
);

export default Page;
