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

export interface SyncModelConfig {
  table: AnyPgTable;
  groupKey: string | "__modelId__" | null;
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
  shutdown: () => Promise<void>;
}
