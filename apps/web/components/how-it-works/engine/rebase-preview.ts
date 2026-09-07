import type { SyncAction, Transaction } from "@stratasync/core";
import {
  rebaseOriginals,
  rebaseTransactions,
  resolveConflictEffect,
} from "@stratasync/core";

/**
 * Section 7 runs the engine's own rebase, not a drawing of it.
 *
 * `rebaseTransactions`, `rebaseOriginals` and `resolveConflictEffect` are pure
 * — no storage, no transport, no client — so the figure can call them directly
 * and cannot drift from what a real client would do. Every outcome the reader
 * sees came out of `@stratasync/core`.
 */

export type Field = "status" | "title";
export type Strategy = "client-wins" | "merge" | "server-wins";

/** The row before either side touched it. */
export const BASE: Record<Field, string> = { status: "open", title: "Draft" };

export const LOCAL_VALUE: Record<Field, string> = {
  status: "done",
  title: "Draft v2",
};

export const SERVER_VALUE: Record<Field, string> = {
  status: "blocked",
  title: "Release notes",
};

const CLIENT_ID = "device-a";

const buildTransaction = (field: Field): Transaction => ({
  action: "U",
  batchIndex: 0,
  clientId: CLIENT_ID,
  clientTxId: "local-1",
  createdAt: 0,
  modelId: "t-1",
  modelName: "Task",
  original: { ...BASE },
  payload: { [field]: LOCAL_VALUE[field] },
  retryCount: 0,
  state: "sent",
});

/** Somebody else's change, so it is never mistaken for this device's own echo. */
const buildAction = (field: Field): SyncAction => ({
  action: "U",
  clientId: "device-b",
  clientTxId: "remote-1",
  data: { [field]: SERVER_VALUE[field] },
  id: "2",
  modelId: "t-1",
  modelName: "Task",
});

export interface RebaseInput {
  fieldLevel: boolean;
  localField: Field;
  serverField: Field;
  strategy: Strategy;
}

export interface RebasePreview {
  /** The row on screen once the rebase has run. */
  after: Record<Field, string>;
  /** How the engine classified it, or null when it saw no conflict at all. */
  conflictType: string | null;
  /** What the engine did with the pending write. */
  effect: "drop-local" | "keep" | "patch-original";
  /** The `original` snapshot the write now carries; null once it is dropped. */
  original: Record<string, unknown> | null;
  /** The row as the server has it, before the local write is re-applied. */
  server: Record<Field, string>;
}

const rowOf = (...parts: Record<string, unknown>[]): Record<Field, string> =>
  Object.assign({}, ...parts) as Record<Field, string>;

export const previewRebase = (input: RebaseInput): RebasePreview => {
  const tx = buildTransaction(input.localField);
  const action = buildAction(input.serverField);

  const result = rebaseTransactions([tx], [action], {
    clientId: CLIENT_ID,
    defaultResolution: input.strategy,
    fieldLevelConflicts: input.fieldLevel,
  });

  const server = rowOf(BASE, action.data);
  const kept = rowOf(server, tx.payload);
  const [conflict] = result.conflicts;

  if (!conflict) {
    /*
     * No conflict, so the write stays pending. `rebaseOriginals` still runs:
     * it moves the snapshot forward for any tracked field the server touched,
     * which is what keeps a later diff honest.
     */
    const [patch] = rebaseOriginals([tx], [action]);
    return {
      after: kept,
      conflictType: null,
      effect: "keep",
      original: patch?.original ?? tx.original ?? {},
      server,
    };
  }

  const effect = resolveConflictEffect(conflict);

  if (effect.kind === "drop-local") {
    return {
      after: server,
      conflictType: conflict.conflictType,
      effect: "drop-local",
      original: null,
      server,
    };
  }

  if (effect.kind === "patch-original") {
    return {
      after: kept,
      conflictType: conflict.conflictType,
      effect: "patch-original",
      original: effect.original,
      server,
    };
  }

  return {
    after: kept,
    conflictType: conflict.conflictType,
    effect: "keep",
    original: tx.original ?? {},
    server,
  };
};
