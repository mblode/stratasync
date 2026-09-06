import type { Metadata } from "next";

import { GuideShell } from "@/components/guide-shell";
import {
  H2,
  H3,
  InlineCode,
  List,
  ListItem,
  P,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from "@/components/ui/typography";
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
    <P>
      Linear&#8217;s engineers described their sync engine in talks and posts
      but never released the code. The{" "}
      <a href={siteConfig.links.linearReference}>reverse-engineering notes</a>{" "}
      wrote it down chapter by chapter, and this page maps each chapter onto the
      module here that implements it.
    </P>
    <P>
      Strata Sync is a clean-room implementation of that published architecture.
      It contains no Linear code, and Linear is not affiliated with or endorsing
      this project.
    </P>

    <H2>Why this architecture</H2>
    <P>
      Most local-first engines reach for CRDTs, which converge without a
      coordinator but carry per-value metadata and get awkward once you need
      partial replication and per-row permissions. Linear went the other way:
      one server, one monotonic counter, and a total order every client replays.
    </P>
    <P>
      That trade buys three things this engine depends on. Ordering is decided
      in one place, so there is no merge function to reason about for records.
      Permissions fall out of the same mechanism as replication, because a
      client only ever receives the groups it subscribes to. And a client that
      has been offline for a week catches up by asking for everything after a
      single integer.
    </P>
    <P>
      Text is the exception, and Strata Sync uses Yjs CRDTs for it. Two people
      typing in one paragraph is exactly the case a server-ordered log handles
      badly.
    </P>

    <H2>The mapping</H2>

    <H3>Models and metadata</H3>
    <Table>
      <Thead>
        <Tr>
          <Th scope="col">Linear</Th>
          <Th scope="col">Strata Sync</Th>
        </Tr>
      </Thead>
      <Tbody>
        <Tr>
          <Td>
            A <InlineCode>ModelRegistry</InlineCode> holding every model&#8217;s
            properties, references and load strategy, populated by decorators at
            startup
          </Td>
          <Td>
            <InlineCode>ModelRegistry</InlineCode> in{" "}
            <InlineCode>@stratasync/core</InlineCode>, populated by{" "}
            <InlineCode>@ClientModel</InlineCode>,{" "}
            <InlineCode>@Property</InlineCode>,{" "}
            <InlineCode>@Reference</InlineCode>,{" "}
            <InlineCode>@BackReference</InlineCode>,{" "}
            <InlineCode>@OneToMany</InlineCode> and{" "}
            <InlineCode>@ReferenceArray</InlineCode> at import time
          </Td>
        </Tr>
        <Tr>
          <Td>Load strategies deciding when a model hydrates</Td>
          <Td>
            <InlineCode>loadStrategy</InlineCode> on{" "}
            <InlineCode>@ClientModel</InlineCode>:{" "}
            <InlineCode>instant</InlineCode>, <InlineCode>lazy</InlineCode>,{" "}
            <InlineCode>partial</InlineCode>,{" "}
            <InlineCode>explicitlyRequested</InlineCode> or{" "}
            <InlineCode>local</InlineCode>
          </Td>
        </Tr>
        <Tr>
          <Td>
            Properties split into an id and a resolved model (
            <InlineCode>assigneeId</InlineCode> plus{" "}
            <InlineCode>assignee</InlineCode>)
          </Td>
          <Td>
            <InlineCode>@Reference</InlineCode> stores the foreign key.{" "}
            <InlineCode>@OneToMany</InlineCode> and{" "}
            <InlineCode>@ReferenceArray</InlineCode> expose lazy collections
            that hydrate on access
          </Td>
        </Tr>
        <Tr>
          <Td>A schema hash that triggers an IndexedDB migration</Td>
          <Td>
            <InlineCode>computeSchemaHash()</InlineCode>. A mismatch on startup
            forces a full re-bootstrap
          </Td>
        </Tr>
      </Tbody>
    </Table>
    <P>
      Registration happens at import time, which is why a model file has to be
      imported for its models to exist. See{" "}
      <a href={`${docs}/packages/core/models`}>Models</a> and{" "}
      <a href={`${docs}/packages/core/schema`}>Schema</a>.
    </P>

    <H3>The object pool</H3>
    <P>
      Linear keeps one object per UUID in a <InlineCode>modelLookup</InlineCode>{" "}
      map, so every reference to an issue is the same instance and a change
      notifies every observer at once. Strata Sync calls this the identity map.
      It is bounded by <InlineCode>identityMapMaxSize</InlineCode>, and eviction
      emits a <InlineCode>modelChange</InlineCode> so hooks re-render and
      re-hydrate on next access rather than reading a stale object.
    </P>

    <H3>Bootstrap and the global sync id</H3>
    <Table>
      <Thead>
        <Tr>
          <Th scope="col">Linear</Th>
          <Th scope="col">Strata Sync</Th>
        </Tr>
      </Thead>
      <Tbody>
        <Tr>
          <Td>
            <InlineCode>lastSyncId</InlineCode>, a monotonic integer that orders
            every change
          </Td>
          <Td>
            <InlineCode>SyncId</InlineCode>, a <strong>string</strong> on the
            wire so the counter can pass{" "}
            <InlineCode>Number.MAX_SAFE_INTEGER</InlineCode> without losing
            precision
          </Td>
        </Tr>
        <Tr>
          <Td>Full, partial and local bootstrapping</Td>
          <Td>
            <InlineCode>
              bootstrapMode: &quot;auto&quot; | &quot;full&quot; |
              &quot;local&quot;
            </InlineCode>
            . <InlineCode>auto</InlineCode> picks full or local from what is
            already stored
          </Td>
        </Tr>
        <Tr>
          <Td>
            Bootstrap streamed as newline-delimited JSON, ending in metadata
          </Td>
          <Td>
            NDJSON from <InlineCode>/sync/bootstrap</InlineCode>, ending in{" "}
            <InlineCode>BootstrapMetadata</InlineCode> with{" "}
            <InlineCode>lastSyncId</InlineCode> and{" "}
            <InlineCode>subscribedSyncGroups</InlineCode>
          </Td>
        </Tr>
        <Tr>
          <Td>
            Only <InlineCode>instant</InlineCode> models load during the initial
            bootstrap
          </Td>
          <Td>Same. Everything else waits for first access</Td>
        </Tr>
      </Tbody>
    </Table>

    <H3>Lazy loading and partial indexes</H3>
    <P>
      Linear identifies a subset of a model by an index key and value (
      <InlineCode>issueId-&lt;uuid&gt;</InlineCode>), records in a{" "}
      <InlineCode>_partial</InlineCode> store which of those it has already
      fetched, and coalesces requests through a batch loader so the same subset
      is never fetched twice.
    </P>
    <P>
      Strata Sync keeps this shape: <InlineCode>hasPartialIndex</InlineCode> and{" "}
      <InlineCode>setPartialIndex</InlineCode> on the storage adapter record
      coverage, <InlineCode>/sync/batch</InlineCode> serves the fetch through{" "}
      <InlineCode>createBatchLoadStream</InlineCode>, and in-flight requests for
      the same key are de-duplicated in the client&#8217;s lazy loader. Coverage
      is only recorded once the fetch succeeds, so a cancelled load does not
      convince the next read that the data is already local.
    </P>
    <P>
      See <a href={`${docs}/guides/load-strategies`}>Load strategies</a>.
    </P>

    <H3>The transaction queue</H3>
    <Table>
      <Thead>
        <Tr>
          <Th scope="col">Linear</Th>
          <Th scope="col">Strata Sync</Th>
        </Tr>
      </Thead>
      <Tbody>
        <Tr>
          <Td>
            Five transaction types: create, update, delete, archive, unarchive
          </Td>
          <Td>
            The same five, as actions <InlineCode>I</InlineCode>,{" "}
            <InlineCode>U</InlineCode>, <InlineCode>D</InlineCode>,{" "}
            <InlineCode>A</InlineCode>, <InlineCode>V</InlineCode>
          </Td>
        </Tr>
        <Tr>
          <Td>
            In-memory model updates immediately. The transaction exists for sync
            and undo, not for local state
          </Td>
          <Td>
            Optimistic updates land in the identity map first. The outbox entry
            is what reaches the server
          </Td>
        </Tr>
        <Tr>
          <Td>
            Queue states from created through executing to &#8220;completed but
            unsynced&#8221;, waiting for the delta that carries its sync id
          </Td>
          <Td>
            <InlineCode>
              queued -&gt; sent -&gt; awaitingSync -&gt; completed
            </InlineCode>
            . A mutate result with no sync id completes immediately instead of
            parking
          </Td>
        </Tr>
        <Tr>
          <Td>Transactions persisted so a restart replays them</Td>
          <Td>
            A durable outbox (<InlineCode>getOutbox</InlineCode>,{" "}
            <InlineCode>addToOutbox</InlineCode>) surviving reload and full
            re-bootstrap
          </Td>
        </Tr>
        <Tr>
          <Td>Idempotency is a caveat</Td>
          <Td>
            <InlineCode>clientId + clientTxId</InlineCode> is the idempotency
            key. The server deduplicates, so a retry after a crash cannot apply
            twice
          </Td>
        </Tr>
      </Tbody>
    </Table>
    <P>
      One deliberate difference: in Linear the client never writes model tables
      from its own mutations, and local tables only advance when the delta
      arrives. Strata Sync writes optimistic state to the identity map but not
      to storage, so a reload before confirmation replays the outbox rather than
      reading an unconfirmed row.
    </P>

    <H3>Delta packets</H3>
    <P>
      Sync actions arrive as <InlineCode>I</InlineCode>,{" "}
      <InlineCode>U</InlineCode>, <InlineCode>D</InlineCode>,{" "}
      <InlineCode>A</InlineCode>, <InlineCode>V</InlineCode>, plus{" "}
      <InlineCode>C</InlineCode> for coverage and <InlineCode>G</InlineCode> for
      a group change. Applying a packet means, in order: handle group changes,
      write the rows, cancel any in-flight creation transaction whose model just
      arrived, rebase what is left of the outbox, and only then advance{" "}
      <InlineCode>lastSyncId</InlineCode>.
    </P>
    <P>
      Rebase is field-level by default (
      <InlineCode>fieldLevelConflicts</InlineCode>), so two clients editing
      different fields of one row do not conflict.{" "}
      <InlineCode>rebaseStrategy</InlineCode> picks what happens when they do
      edit the same field: <InlineCode>server-wins</InlineCode> (the default)
      rolls the local change back, <InlineCode>client-wins</InlineCode> and{" "}
      <InlineCode>merge</InlineCode> update the baseline instead.
    </P>
    <P>
      See <a href={`${docs}/guides/conflict-resolution`}>Conflict resolution</a>
      .
    </P>

    <H3>Sync groups</H3>
    <P>
      Groups are the permission boundary. A client receives deltas only for the
      groups it subscribes to, and <InlineCode>auth.resolveGroups</InlineCode>{" "}
      on the server decides what those are per request.
    </P>
    <P>
      Membership changes ship as durable <InlineCode>&quot;G&quot;</InlineCode>{" "}
      sync actions rather than control frames, so a user who is offline when
      they are added to a team still learns about it on their next catch-up. A
      group action holds the cursor and forces a full re-bootstrap, which the
      server filters on current membership, so it converges whether a group was
      added (its history sits before the cursor and would never arrive as
      deltas) or removed (its rows would otherwise stay cached). The
      re-bootstrap is latched in local metadata until one completes, so a client
      stopped mid-way still owes it on the next start.
    </P>

    <H3>Undo and redo</H3>
    <P>
      Every mutation records its inverse. <InlineCode>client.undo()</InlineCode>{" "}
      sends that inverse as an ordinary transaction, so it syncs and other
      clients see a normal update, delete or insert.{" "}
      <InlineCode>runAsUndoGroup()</InlineCode> collapses several mutations into
      one undoable step, and a server rejection drops the entry from both stacks
      rather than leaving an undo that would replay a write the server refused.
    </P>

    <H2>What Strata Sync adds</H2>
    <List>
      <ListItem>
        <strong>Collaborative text.</strong> Yjs CRDT documents and presence in{" "}
        <InlineCode>@stratasync/y-doc</InlineCode>, with{" "}
        <InlineCode>useYjsDocument</InlineCode> and{" "}
        <InlineCode>useYjsPresence</InlineCode>. See{" "}
        <a href={`${docs}/guides/collaborative-editing`}>
          Collaborative editing
        </a>
        .
      </ListItem>
      <ListItem>
        <strong>Swappable adapters.</strong> Storage, transport and reactivity
        are separate packages behind one interface each, so the core runs in
        Node with no browser or network.
      </ListItem>
      <ListItem>
        <strong>A server you own.</strong>{" "}
        <InlineCode>@stratasync/server</InlineCode> registers the bootstrap,
        batch, delta, mutate and WebSocket routes on your own Fastify app and
        stores the log in your own Postgres through Drizzle. Redis is optional,
        for fanning deltas across processes.
      </ListItem>
    </List>
    <P>
      For the protocol on the wire, read{" "}
      <a href={`${docs}/architecture/sync-protocol`}>the sync protocol</a>. If
      you are still deciding whether this is the right shape at all,{" "}
      <a href={`${siteConfig.url}/guides/what-is-a-sync-engine`}>
        what a sync engine is
      </a>{" "}
      covers when the answer should be no.
    </P>
  </GuideShell>
);

export default Page;
