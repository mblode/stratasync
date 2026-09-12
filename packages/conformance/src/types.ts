/**
 * Types for the conformance corpus. These mirror `corpus/schemas/*.json`,
 * which stay the authority for anything a non-TypeScript port reads; the
 * corpus test suite validates every file against those schemas, so the two
 * cannot drift silently.
 */

/** Version of the stdin/stdout driver protocol described in `corpus/README.md`. */
export const DRIVER_PROTOCOL_VERSION = 1;

/**
 * A feature an implementation may or may not support. An undeclared subset is
 * the failure this vocabulary exists to prevent.
 */
export type Capability =
  | "bootstrap"
  | "deltaFetch"
  | "websocket"
  | "outbox"
  | "rebase"
  | "archive"
  | "syncGroups"
  | "schemaHashGating"
  | "loadStrategies"
  | "partialLoad"
  | "undoRedo"
  | "crdt";

export interface CapabilityManifest {
  implementation: string;
  language: "typescript" | "swift" | "kotlin";
  protocolVersion: number;
  corpusVersion?: string;
  capabilities: Capability[];
  notes?: Record<string, string>;
}

/** A table of input → expected output for one named pure function. */
export interface VectorFile {
  fn: string;
  description: string;
  requires?: Capability[];
  cases: VectorCase[];
}

export interface VectorCase {
  name: string;
  /** An array is spread as positional arguments; anything else is one argument. */
  input: unknown;
  expected?: unknown;
  /** The call must fail. The message is deliberately not part of the contract. */
  throws?: boolean;
}

/** Wire-encoded sync ID: a decimal string, because these outgrow 2^53. */
export type SyncId = string;

/** Single-letter action codes as they appear in the sync log. */
export type LogAction = "I" | "U" | "D" | "A" | "V";

/** Spelled-out action names as they appear in a mutation request. */
export type MutationAction =
  | "INSERT"
  | "UPDATE"
  | "DELETE"
  | "ARCHIVE"
  | "UNARCHIVE";

export type FieldCodec =
  | "id"
  | "string"
  | "optionalString"
  | "number"
  | "optionalNumber"
  | "boolean"
  | "date"
  | "optionalDate"
  | "json";

export type LoadStrategy =
  | "instant"
  | "lazy"
  | "partial"
  | "explicitlyRequested"
  | "local";

export type EngineState =
  | "disconnected"
  | "connecting"
  | "bootstrapping"
  | "syncing"
  | "error";

export interface ScenarioModel {
  name: string;
  groupKey?: string;
  loadStrategy?: LoadStrategy;
  /** Field name → codec kind. This is what "decoding-relevant schema" means. */
  fields: Record<string, FieldCodec>;
}

export interface Row {
  model: string;
  id: string;
  fields: Record<string, unknown>;
}

export interface OutboxEntry {
  clientTxId: string;
  action: MutationAction;
  model: string;
  modelId: string;
  payload?: Record<string, unknown>;
  status?: "pending" | "inflight" | "failed";
}

export interface StorageMeta {
  lastSyncId?: SyncId;
  firstSyncId?: SyncId;
  schemaHash?: string | null;
  bootstrapComplete?: boolean;
  subscribedGroups?: string[];
}

export interface SyncActionRecord {
  syncId: SyncId;
  modelName: string;
  modelId: string;
  action: LogAction;
  data?: Record<string, unknown> | null;
  groupId?: string;
  clientId?: string;
  clientTxId?: string;
}

export interface DeltaPacket {
  lastSyncId: SyncId;
  actions: SyncActionRecord[];
  hasMore?: boolean;
}

export type Step =
  | { op: "start"; groups?: string[] }
  | { op: "stop" }
  | {
      op: "respondBootstrap";
      rows: Row[];
      lastSyncId?: SyncId;
      schemaHash?: string;
    }
  | { op: "respondDeltas"; packet: DeltaPacket }
  | { op: "deliverDelta"; packet: DeltaPacket }
  | { op: "socketOpen" }
  | { op: "socketClose"; code?: number }
  | {
      op: "transportError";
      kind: "network" | "unauthorized" | "bootstrapRequired" | "serverError";
      on?: "bootstrap" | "deltas" | "mutate";
    }
  | { op: "advanceClock"; ms: number }
  | {
      op: "mutate";
      action: MutationAction;
      model: string;
      modelId: string;
      payload?: Record<string, unknown>;
    }
  | { op: "ackMutation"; clientTxId: string; syncId?: SyncId }
  | { op: "rejectMutation"; clientTxId: string; message?: string }
  | Expectation;

/** Only the keys present are asserted, so a scenario does not over-specify. */
export interface Expectation {
  op: "expect";
  label?: string;
  state?: EngineState;
  cursor?: SyncId;
  store?: Row[];
  storeAbsent?: { model: string; id: string }[];
  outbox?: OutboxEntry[];
  transport?: {
    bootstrapCount?: number;
    deltaFetchCount?: number;
    mutateCount?: number;
    socketConnectCount?: number;
  };
  storage?: StorageMeta;
}

export interface Scenario {
  id: string;
  description: string;
  requires?: Capability[];
  seed?: { clientId?: string; clock?: number; txIds?: string[] };
  models: ScenarioModel[];
  given?: { meta?: StorageMeta; rows?: Row[]; outbox?: OutboxEntry[] };
  steps: Step[];
}

/** What a driver writes to stdout for `run`. */
export interface ScenarioResult {
  scenarioId: string;
  ok: boolean;
  /** One entry per step, in order. Failures carry a human-readable diff. */
  steps: StepResult[];
  /** Set when the driver could not run the scenario at all. */
  error?: string;
}

export interface StepResult {
  index: number;
  op: string;
  ok: boolean;
  label?: string;
  /** Present only when `ok` is false. */
  failures?: string[];
}

/** `manifest.json` at the corpus root. */
export interface CorpusManifest {
  version: string;
  protocolVersion: number;
  /** Corpus-relative path → SHA-256, so a vendored copy can prove it is in sync. */
  files: Record<string, string>;
}
