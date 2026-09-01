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
}

export interface SyncAuthConfig {
  verifyToken: (token: string) => Promise<SyncAuthPayload | null>;
  resolveGroups: (userId: string) => Promise<string[]>;
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
   * Tells a user's live sessions they now belong to a group, so they batch-load
   * it. The group's history sits before their delta cursor, so without this a
   * newly shared group delivers nothing until the next bootstrap.
   *
   * This only emits the frame — writing the membership row is the caller's job
   * (`syncDao.addGroupMembership`, or whatever model handler does the sharing).
   * A user with no socket open is a silent no-op.
   */
  notifyGroupJoined: (userId: string, groupId: string) => Promise<void>;
  /**
   * Tells a user's live sessions they no longer belong to a group, so they drop
   * its cached rows. Without this the rows simply stop updating and linger.
   * Emits the frame only; revoking the membership row is the caller's job.
   */
  notifyGroupLeft: (userId: string, groupId: string) => Promise<void>;
  shutdown: () => Promise<void>;
}
