import type { ReactNode } from "react";

import { siteConfig } from "@/lib/config";

/**
 * Linear's architecture, chapter by chapter, against the Strata Sync module
 * that implements it. Vocabulary follows the reverse-engineering notes at
 * `siteConfig.links.linearReference`; every cell names a real export or
 * option from `packages/*\/src/index.ts`, so keep it in step with them.
 */
interface LineageRow {
  linear: string;
  strata: ReactNode;
}

const Code = ({ children }: { children: ReactNode }) => (
  <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.8em] text-foreground">
    {children}
  </code>
);

const rows: LineageRow[] = [
  {
    linear: "Model registry and decorators, with per-model load strategies",
    strata: (
      <>
        <Code>ModelRegistry</Code>, <Code>@ClientModel</Code>,{" "}
        <Code>@Property</Code>, <Code>@Reference</Code>,{" "}
        <Code>@BackReference</Code>, <Code>@OneToMany</Code> in{" "}
        <Code>@stratasync/core</Code>. <Code>loadStrategy</Code> is{" "}
        <Code>instant</Code>, <Code>lazy</Code>, <Code>partial</Code>,{" "}
        <Code>explicitlyRequested</Code> or <Code>local</Code>.
      </>
    ),
  },
  {
    linear: "Object pool: one instance per id",
    strata: (
      <>
        The client identity map: <Code>client.getIdentityMap()</Code>, bounded
        by <Code>identityMapMaxSize</Code>.
      </>
    ),
  },
  {
    linear: "Bootstrap (full, partial, local) keyed by a global lastSyncId",
    strata: (
      <>
        <Code>
          bootstrapMode: &quot;auto&quot; | &quot;full&quot; | &quot;local&quot;
        </Code>
        . NDJSON streamed from <Code>/sync/bootstrap</Code> by{" "}
        <Code>BootstrapService</Code>, ending in <Code>BootstrapMetadata</Code>{" "}
        with <Code>lastSyncId</Code> and <Code>subscribedSyncGroups</Code>.
      </>
    ),
  },
  {
    linear: "Partial indexes and a de-duplicating batch loader",
    strata: (
      <>
        <Code>hasPartialIndex</Code> / <Code>setPartialIndex</Code> on the
        storage adapter, <Code>/sync/batch</Code> via{" "}
        <Code>createBatchLoadStream</Code>, and in-flight de-duplication in the
        client&apos;s lazy loader.
      </>
    ),
  },
  {
    linear: "Transaction queue with persisted state for restart replay",
    strata: (
      <>
        <Code>queued → sent → awaitingSync → completed</Code>, held in a durable
        outbox (<Code>getOutbox</Code>, <Code>addToOutbox</Code>) and keyed by{" "}
        <Code>clientId + clientTxId</Code> for idempotent retries.
      </>
    ),
  },
  {
    linear: "Delta packets of sync actions (I, U, D, A, V, plus C and G)",
    strata: (
      <>
        <Code>DeltaPacket</Code>, <Code>SyncAction</Code> and{" "}
        <Code>applyDeltas</Code> in core; served by <Code>/sync/deltas</Code>{" "}
        and <Code>/sync/ws</Code> through <Code>DeltaService</Code> and{" "}
        <Code>createDeltaPublisher</Code>, with optional Redis fan-out.
      </>
    ),
  },
  {
    linear: "Rebase in-flight local changes on incoming deltas",
    strata: (
      <>
        <Code>rebaseTransactions</Code> with{" "}
        <Code>
          rebaseStrategy: &quot;server-wins&quot; | &quot;client-wins&quot; |
          &quot;merge&quot;
        </Code>{" "}
        and <Code>fieldLevelConflicts</Code>.
      </>
    ),
  },
  {
    linear: "Sync groups as the permission boundary",
    strata: (
      <>
        <Code>groups</Code> on the client; <Code>auth.resolveGroups</Code> and
        the <Code>sync_group_memberships</Code> table on the server. Membership
        changes ship as durable <Code>&quot;G&quot;</Code> actions via{" "}
        <Code>notifyGroupsChanged()</Code>.
      </>
    ),
  },
  {
    linear: "Schema hash that triggers a local migration",
    strata: (
      <>
        <Code>computeSchemaHash()</Code>; a mismatch forces a full re-bootstrap,
        and <Code>migrations</Code> hooks run inside the IndexedDB upgrade.
      </>
    ),
  },
  {
    linear: "Undo and redo from transaction history",
    strata: (
      <>
        <Code>client.undo()</Code>, <Code>client.redo()</Code>,{" "}
        <Code>runAsUndoGroup()</Code>, built on{" "}
        <Code>createUndoTransaction</Code>.
      </>
    ),
  },
];

const additions: LineageRow[] = [
  {
    linear: "Collaborative text",
    strata: (
      <>
        Yjs CRDT documents and presence in <Code>@stratasync/y-doc</Code>, with{" "}
        <Code>useYjsDocument</Code> and <Code>useYjsPresence</Code> hooks.
      </>
    ),
  },
  {
    linear: "Swappable adapters",
    strata: (
      <>
        Storage (<Code>storage-idb</Code>, <Code>storage-local</Code>),
        transport (<Code>transport-graphql</Code>) and reactivity (
        <Code>mobx</Code>) are separate packages behind one interface each.
      </>
    ),
  },
];

const LineageTable = ({
  caption,
  data,
  leftHeading,
}: {
  caption: string;
  data: LineageRow[];
  leftHeading: string;
}) => (
  <div className="overflow-x-auto rounded-2xl border border-border bg-card">
    <table className="w-full text-left text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead className="border-border border-b text-muted-foreground text-xs">
        <tr>
          <th className="px-5 py-3 font-medium" scope="col">
            {leftHeading}
          </th>
          <th className="px-5 py-3 font-medium" scope="col">
            In Strata Sync
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {data.map((row) => (
          <tr className="align-top" key={row.linear}>
            <th
              className="w-2/5 min-w-56 px-5 py-3.5 font-medium text-foreground"
              scope="row"
            >
              {row.linear}
            </th>
            <td className="px-5 py-3.5 text-muted-foreground leading-relaxed">
              {row.strata}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const LandingLineage = () => (
  <section className="py-16 md:py-20" id="linear">
    <div className="container-wrapper">
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="space-y-4">
          <h2 className="mx-auto max-w-xl text-balance text-center font-sans text-3xl font-medium tracking-tight md:text-4xl">
            Linear&#8217;s sync engine, open-sourced
          </h2>
          <p className="mx-auto max-w-2xl text-balance text-center text-muted-foreground">
            Linear&#8217;s engineers described their sync engine in talks and
            posts, and the{" "}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={siteConfig.links.linearReference}
              rel="noopener noreferrer"
              target="_blank"
            >
              reverse-engineering notes
            </a>{" "}
            wrote it down chapter by chapter. Strata Sync implements each
            chapter in TypeScript, on your own Postgres.
          </p>
        </div>

        <LineageTable
          caption="Linear's sync engine architecture mapped to the Strata Sync module that implements it"
          data={rows}
          leftHeading="Linear's architecture"
        />

        <LineageTable
          caption="What Strata Sync adds beyond Linear's published architecture"
          data={additions}
          leftHeading="Added in Strata Sync"
        />

        <p className="mx-auto max-w-2xl text-center text-muted-foreground text-sm">
          Strata Sync is a clean-room implementation of the published
          architecture. It contains no Linear code, and Linear is not affiliated
          with or endorsing this project.
        </p>
      </div>
    </div>
  </section>
);
