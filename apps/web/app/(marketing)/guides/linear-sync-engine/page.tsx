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
      wrote it down chapter by chapter, and this page maps each chapter onto the
      module here that implements it.
    </p>
    <p>
      Strata Sync is a clean-room implementation of that published architecture.
      It contains no Linear code, and Linear is not affiliated with or endorsing
      this project.
    </p>

    <h2>Why this architecture</h2>
    <p>
      Most local-first engines reach for CRDTs, which converge without a
      coordinator but carry per-value metadata and get awkward once you need
      partial replication and per-row permissions. Linear went the other way:
      one server, one monotonic counter, and a total order every client replays.
    </p>
    <p>
      That trade buys three things this engine depends on. Ordering is decided
      in one place, so there is no merge function to reason about for records.
      Permissions fall out of the same mechanism as replication, because a
      client only ever receives the groups it subscribes to. And a client that
      has been offline for a week catches up by asking for everything after a
      single integer.
    </p>
    <p>
      Text is the exception, and Strata Sync uses Yjs CRDTs for it. Two people
      typing in one paragraph is exactly the case a server-ordered log handles
      badly.
    </p>

    <h2>The mapping</h2>

    <h3>Models and metadata</h3>
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
            A <code>ModelRegistry</code> holding every model&#8217;s properties,
            references and load strategy, populated by decorators at startup
          </td>
          <td>
            <code>ModelRegistry</code> in <code>@stratasync/core</code>,
            populated by <code>@ClientModel</code>, <code>@Property</code>,{" "}
            <code>@Reference</code>, <code>@BackReference</code>,{" "}
            <code>@OneToMany</code> and <code>@ReferenceArray</code> at import
            time
          </td>
        </tr>
        <tr>
          <td>Load strategies deciding when a model hydrates</td>
          <td>
            <code>loadStrategy</code> on <code>@ClientModel</code>:{" "}
            <code>instant</code>, <code>lazy</code>, <code>partial</code>,{" "}
            <code>explicitlyRequested</code> or <code>local</code>
          </td>
        </tr>
        <tr>
          <td>
            Properties split into an id and a resolved model (
            <code>assigneeId</code> plus <code>assignee</code>)
          </td>
          <td>
            <code>@Reference</code> stores the foreign key.{" "}
            <code>@OneToMany</code> and <code>@ReferenceArray</code> expose lazy
            collections that hydrate on access
          </td>
        </tr>
        <tr>
          <td>A schema hash that triggers an IndexedDB migration</td>
          <td>
            <code>computeSchemaHash()</code>. A mismatch on startup forces a
            full re-bootstrap
          </td>
        </tr>
      </tbody>
    </table>
    <p>
      Registration happens at import time, which is why a model file has to be
      imported for its models to exist. See{" "}
      <a href={`${docs}/packages/core/models`}>Models</a> and{" "}
      <a href={`${docs}/packages/core/schema`}>Schema</a>.
    </p>

    <h3>The object pool</h3>
    <p>
      Linear keeps one object per UUID in a <code>modelLookup</code> map, so
      every reference to an issue is the same instance and a change notifies
      every observer at once. Strata Sync calls this the identity map. It is
      bounded by <code>identityMapMaxSize</code>, and eviction emits a{" "}
      <code>modelChange</code> so hooks re-render and re-hydrate on next access
      rather than reading a stale object.
    </p>

    <h3>Bootstrap and the global sync id</h3>
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
            <code>lastSyncId</code>, a monotonic integer that orders every
            change
          </td>
          <td>
            <code>SyncId</code>, a <strong>string</strong> on the wire so the
            counter can pass <code>Number.MAX_SAFE_INTEGER</code> without losing
            precision
          </td>
        </tr>
        <tr>
          <td>Full, partial and local bootstrapping</td>
          <td>
            <code>
              bootstrapMode: &quot;auto&quot; | &quot;full&quot; |
              &quot;local&quot;
            </code>
            . <code>auto</code> picks full or local from what is already stored
          </td>
        </tr>
        <tr>
          <td>
            Bootstrap streamed as newline-delimited JSON, ending in metadata
          </td>
          <td>
            NDJSON from <code>/sync/bootstrap</code>, ending in{" "}
            <code>BootstrapMetadata</code> with <code>lastSyncId</code> and{" "}
            <code>subscribedSyncGroups</code>
          </td>
        </tr>
        <tr>
          <td>
            Only <code>instant</code> models load during the initial bootstrap
          </td>
          <td>Same. Everything else waits for first access</td>
        </tr>
      </tbody>
    </table>

    <h3>Lazy loading and partial indexes</h3>
    <p>
      Linear identifies a subset of a model by an index key and value (
      <code>issueId-&lt;uuid&gt;</code>), records in a <code>_partial</code>{" "}
      store which of those it has already fetched, and coalesces requests
      through a batch loader so the same subset is never fetched twice.
    </p>
    <p>
      Strata Sync keeps this shape: <code>hasPartialIndex</code> and{" "}
      <code>setPartialIndex</code> on the storage adapter record coverage,{" "}
      <code>/sync/batch</code> serves the fetch through{" "}
      <code>createBatchLoadStream</code>, and in-flight requests for the same
      key are de-duplicated in the client&#8217;s lazy loader. Coverage is only
      recorded once the fetch succeeds, so a cancelled load does not convince
      the next read that the data is already local.
    </p>
    <p>
      See <a href={`${docs}/guides/load-strategies`}>Load strategies</a>.
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
          <td>
            Five transaction types: create, update, delete, archive, unarchive
          </td>
          <td>
            The same five, as actions <code>I</code>, <code>U</code>,{" "}
            <code>D</code>, <code>A</code>, <code>V</code>
          </td>
        </tr>
        <tr>
          <td>
            In-memory model updates immediately. The transaction exists for sync
            and undo, not for local state
          </td>
          <td>
            Optimistic updates land in the identity map first. The outbox entry
            is what reaches the server
          </td>
        </tr>
        <tr>
          <td>
            Queue states from created through executing to &#8220;completed but
            unsynced&#8221;, waiting for the delta that carries its sync id
          </td>
          <td>
            <code>queued -&gt; sent -&gt; awaitingSync -&gt; completed</code>. A
            mutate result with no sync id completes immediately instead of
            parking
          </td>
        </tr>
        <tr>
          <td>Transactions persisted so a restart replays them</td>
          <td>
            A durable outbox (<code>getOutbox</code>, <code>addToOutbox</code>)
            surviving reload and full re-bootstrap
          </td>
        </tr>
        <tr>
          <td>Idempotency is a caveat</td>
          <td>
            <code>clientId + clientTxId</code> is the idempotency key. The
            server deduplicates, so a retry after a crash cannot apply twice
          </td>
        </tr>
      </tbody>
    </table>
    <p>
      One deliberate difference: in Linear the client never writes model tables
      from its own mutations, and local tables only advance when the delta
      arrives. Strata Sync writes optimistic state to the identity map but not
      to storage, so a reload before confirmation replays the outbox rather than
      reading an unconfirmed row.
    </p>

    <h3>Delta packets</h3>
    <p>
      Sync actions arrive as <code>I</code>, <code>U</code>, <code>D</code>,{" "}
      <code>A</code>, <code>V</code>, plus <code>C</code> for coverage and{" "}
      <code>G</code> for a group change. Applying a packet means, in order:
      handle group changes, write the rows, cancel any in-flight creation
      transaction whose model just arrived, rebase what is left of the outbox,
      and only then advance <code>lastSyncId</code>.
    </p>
    <p>
      Rebase is field-level by default (<code>fieldLevelConflicts</code>), so
      two clients editing different fields of one row do not conflict.{" "}
      <code>rebaseStrategy</code> picks what happens when they do edit the same
      field: <code>server-wins</code> (the default) rolls the local change back,{" "}
      <code>client-wins</code> and <code>merge</code> update the baseline
      instead.
    </p>
    <p>
      See <a href={`${docs}/guides/conflict-resolution`}>Conflict resolution</a>
      .
    </p>

    <h3>Sync groups</h3>
    <p>
      Groups are the permission boundary. A client receives deltas only for the
      groups it subscribes to, and <code>auth.resolveGroups</code> on the server
      decides what those are per request.
    </p>
    <p>
      Membership changes ship as durable <code>&quot;G&quot;</code> sync actions
      rather than control frames, so a user who is offline when they are added
      to a team still learns about it on their next catch-up. A group action
      holds the cursor and forces a full re-bootstrap, which the server filters
      on current membership, so it converges whether a group was added (its
      history sits before the cursor and would never arrive as deltas) or
      removed (its rows would otherwise stay cached). The re-bootstrap is
      latched in local metadata until one completes, so a client stopped mid-way
      still owes it on the next start.
    </p>

    <h3>Undo and redo</h3>
    <p>
      Every mutation records its inverse. <code>client.undo()</code> sends that
      inverse as an ordinary transaction, so it syncs and other clients see a
      normal update, delete or insert. <code>runAsUndoGroup()</code> collapses
      several mutations into one undoable step, and a server rejection drops the
      entry from both stacks rather than leaving an undo that would replay a
      write the server refused.
    </p>

    <h2>What Strata Sync adds</h2>
    <ul>
      <li>
        <strong>Collaborative text.</strong> Yjs CRDT documents and presence in{" "}
        <code>@stratasync/y-doc</code>, with <code>useYjsDocument</code> and{" "}
        <code>useYjsPresence</code>. See{" "}
        <a href={`${docs}/guides/collaborative-editing`}>
          Collaborative editing
        </a>
        .
      </li>
      <li>
        <strong>Swappable adapters.</strong> Storage, transport and reactivity
        are separate packages behind one interface each, so the core runs in
        Node with no browser or network.
      </li>
      <li>
        <strong>A server you own.</strong> <code>@stratasync/server</code>{" "}
        registers the bootstrap, batch, delta, mutate and WebSocket routes on
        your own Fastify app and stores the log in your own Postgres through
        Drizzle. Redis is optional, for fanning deltas across processes.
      </li>
    </ul>
    <p>
      For the protocol on the wire, read{" "}
      <a href={`${docs}/architecture/sync-protocol`}>the sync protocol</a>. If
      you are still deciding whether this is the right shape at all,{" "}
      <a href={`${siteConfig.url}/guides/what-is-a-sync-engine`}>
        what a sync engine is
      </a>{" "}
      covers when the answer should be no.
    </p>
  </GuideShell>
);

export default Page;
