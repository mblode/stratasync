import type { SQL } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import type {
  RedisClientType,
  RedisFunctions,
  RedisModules,
  RedisScripts,
} from "redis";
import type { WebSocket } from "ws";

import type { BootstrapService } from "./bootstrap/bootstrap-service.js";
import type { SyncDao } from "./dao/sync-dao.js";
import type {
  DeltaPublisherLike,
  DeltaSubscriberLike,
} from "./delta/delta-publisher.js";
import type { DeltaService } from "./delta/delta-service.js";
import type { FieldSpec } from "./mutate/field-codecs.js";
import type { MutateService } from "./mutate/mutate-service.js";
import type { ModelAction, SyncUserContext } from "./types.js";

export type { FieldSpec, FieldType } from "./mutate/field-codecs.js";

export type RedisClient = RedisClientType<
  RedisModules,
  RedisFunctions,
  RedisScripts
>;

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface SyncLogger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

const noop = (): void => {
  // Intentionally empty. Used as a no-op stub for the optional logger.
};

export const noopLogger: SyncLogger = {
  debug: noop,
  error: noop,
  info: noop,
  warn: noop,
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface SyncAuthPayload {
  userId: string;
  email?: string;
  name?: string | null;
  /**
   * Opaque credential identity for application authorization policy. The sync
   * server carries it without interpreting it.
   */
  principal?: unknown;
}

export type SyncAccessOperation = "read" | "write";

export interface SyncAccessContext {
  groups: readonly string[];
  operation: SyncAccessOperation;
  principal: unknown;
  user: SyncAuthPayload;
}

export interface SyncAccessDecision {
  /** Exact subset of resolved groups this credential may use. */
  allowedGroups: readonly string[];
}

export interface SyncAuthConfig {
  verifyToken: (token: string) => Promise<SyncAuthPayload | null>;
  resolveGroups: (userId: string) => Promise<string[]>;
  /**
   * Narrows a credential to an operation and a subset of the user's resolved
   * groups. A principal without this policy is rejected rather than treated as
   * an unrestricted user.
   */
  authorizeAccess?: (
    context: SyncAccessContext
  ) => SyncAccessDecision | false | Promise<SyncAccessDecision | false>;
}

// ---------------------------------------------------------------------------
// Bootstrap config
// ---------------------------------------------------------------------------

export interface BootstrapFilterContext {
  authorizedGroupIds: string[];
  workspaceGroupIds: string[];
  userId: string;
}

export type CursorConfig =
  | {
      type: "simple";
      idField: string;
    }
  | {
      type: "composite";
      fields: readonly string[];
      syntheticId: (item: Record<string, unknown>) => string;
    };

export interface BootstrapFieldDef {
  fields: readonly string[];
  dateOnlyFields?: readonly string[];
  instantFields?: readonly string[];
}

export interface BootstrapModelConfig {
  fields: readonly string[];
  dateOnlyFields?: readonly string[];
  instantFields?: readonly string[];
  cursor: CursorConfig;
  buildScopeWhere: (
    filter: BootstrapFilterContext,
    db: unknown
  ) => SQL<unknown>;
  allowedIndexedKeys?: readonly string[];
}

// ---------------------------------------------------------------------------
// Mutate config
// ---------------------------------------------------------------------------

export interface MutationContext {
  modelName: string;
  modelId: string;
  action: ModelAction;
  payload: Record<string, unknown>;
  data: Record<string, unknown>;
  syncAction: { id: bigint };
}

export interface StandardMutateConfig {
  kind: "standard";
  idField?: string;
  actions: Set<ModelAction>;
  insertFields: Record<string, FieldSpec>;
  updateFields?: Set<string>;
  onBeforeInsert?: (
    db: unknown,
    modelId: string,
    payload: Record<string, unknown>,
    data: Record<string, unknown>,
    context?: SyncUserContext
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  onBeforeUpdate?: (
    db: unknown,
    modelId: string,
    payload: Record<string, unknown>,
    data: Record<string, unknown>,
    context?: SyncUserContext
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  onBeforeDelete?: (
    db: unknown,
    modelId: string,
    payload: Record<string, unknown>,
    context?: SyncUserContext
  ) => void | Promise<void>;
  onAfterMutation?: (ctx: MutationContext) => void | Promise<void>;
}

export interface CompositeMutateConfig {
  kind: "composite";
  actions: Set<ModelAction>;
  insertFields: Record<string, FieldSpec>;
  buildDeleteWhere: (payload: Record<string, unknown>) => SQL<unknown>;
  compositeId?: {
    computeId: (
      modelName: string,
      modelId: string,
      payload: Record<string, unknown>
    ) => string;
  };
  onBeforeInsert?: (
    db: unknown,
    modelId: string,
    payload: Record<string, unknown>,
    data: Record<string, unknown>,
    context?: SyncUserContext
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  onBeforeDelete?: (
    db: unknown,
    modelId: string,
    payload: Record<string, unknown>,
    context?: SyncUserContext
  ) => void | Promise<void>;
  onAfterMutation?: (ctx: MutationContext) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Per-model config
// ---------------------------------------------------------------------------

/**
 * Arguments handed to {@link SyncModelConfig.resolveGroup}.
 *
 * `record` is the model's existing row, looked up only for non-insert actions
 * and only when the model has a resolvable delegate; it is `null` for inserts
 * and for models whose row cannot be looked up.
 */
export interface ResolveGroupContext {
  db: unknown;
  modelName: string;
  modelId: string;
  action: ModelAction;
  payload: Record<string, unknown>;
  record: Record<string, unknown> | null;
  context: SyncUserContext;
}

export interface SyncModelConfig {
  table: AnyPgTable;
  groupKey: string | "__modelId__" | null;
  /**
   * Optional per-row group resolution. When present it takes precedence over
   * `groupKey`, so a row's audience can depend on the row itself rather than on
   * a single static column. Returning `null` means "ungrouped", exactly as
   * `groupKey: null` does.
   */
  resolveGroup?: (
    ctx: ResolveGroupContext
  ) => string | null | Promise<string | null>;
  /**
   * Group type recorded on memberships this model creates. Defaults to the
   * model name. Only consulted when `insertCreatesGroup` is true.
   */
  groupType?: string;
  /**
   * When true, an INSERT whose resolved group is absent from `context.groups`
   * grants the creator that membership instead of being denied.
   *
   * This exists because group resolution runs *before* the model mutation, so a
   * model whose group is its own id can never be inserted: the group does not
   * exist yet and the creator is not a member. The flag makes that one moment —
   * group creation — expressible. Every other action is unchanged: you still
   * cannot write to a group you do not belong to.
   *
   * Only set this on a model whose resolved group is unforgeable by the caller
   * — in practice, the row's own id. On a model that resolves to some *other*
   * row's group (a task resolving to its project, say) this flag would hand a
   * non-member membership of that group simply by inserting into it. Such a
   * model should leave the flag off and be denied normally.
   */
  insertCreatesGroup?: boolean;
  bootstrap: BootstrapModelConfig;
  mutate: StandardMutateConfig | CompositeMutateConfig;
}

// ---------------------------------------------------------------------------
// WebSocket hooks
// ---------------------------------------------------------------------------

export interface WebSocketConnectionContext {
  userId: string;
  connId: string;
  groups: string[];
  principal?: unknown;
}

export interface WebSocketHooks {
  onMessage?: (
    ws: WebSocket,
    message: Record<string, unknown>,
    context: WebSocketConnectionContext
  ) => Promise<boolean>;
  onClose?: (
    ws: WebSocket,
    context: WebSocketConnectionContext
  ) => Promise<void>;
  onSubscribe?: (
    ws: WebSocket,
    context: WebSocketConnectionContext,
    previousContext: WebSocketConnectionContext
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Top-level server config
// ---------------------------------------------------------------------------

export interface SyncServerConfig {
  db: unknown;
  tables: {
    syncActions: AnyPgTable;
    syncGroupMemberships: AnyPgTable;
  };
  redis?: RedisClient;
  models: Record<string, SyncModelConfig>;
  auth: SyncAuthConfig;
  logger?: SyncLogger;
  compositeIdNamespace?: string;
}

// ---------------------------------------------------------------------------
// SyncServer return type
// ---------------------------------------------------------------------------

export interface SyncServer {
  bootstrapService: BootstrapService;
  deltaService: DeltaService;
  mutateService: MutateService;
  deltaPublisher: DeltaPublisherLike;
  deltaSubscriber: DeltaSubscriberLike;
  syncDao: SyncDao;
  registerRoutes: (server: unknown) => void;
  /**
   * Tells a user their sync-group membership changed.
   *
   * Writes a `"G"` sync action addressed to the user's own group carrying their
   * current group list, then publishes it. Credential-aware delivery narrows
   * that payload to the final authorized groups. Because it is an ordinary sync
   * action it is durable: it is delivered on the live delta stream if they are
   * connected, and by replay or catch-up whenever they next are. That is the
   * point — a membership change must not be lost while a user is offline, or
   * their cache keeps serving rows from a group they no longer belong to.
   *
   * The group list is recomputed here from the same sources `authorizeToken`
   * uses, so what the client is told matches what it would get on reconnect.
   * Call this after writing or revoking the membership itself.
   */
  notifyGroupsChanged: (userId: string) => Promise<void>;
  shutdown: () => Promise<void>;
}
