import { eq, getTableColumns } from "drizzle-orm";

import type { ResolveGroupContext, SyncModelConfig } from "../config.js";
import type { SyncDb } from "../db.js";
import type { ModelAction, SyncUserContext } from "../types.js";
import {
  createCompositeDelegate,
  createModelHandler,
  createStandardDelegate,
} from "./model-handlers.js";
import type { ModelDef, MutationDelegate } from "./model-handlers.js";

export type ModelLookup = (
  db: unknown,
  id: string
) => Promise<Record<string, unknown> | null>;

export type ModelHandler = (
  db: unknown,
  modelId: string,
  payload: Record<string, unknown>,
  action: ModelAction,
  context?: SyncUserContext
) => Promise<Record<string, unknown>>;

export type GroupResolver = (
  ctx: ResolveGroupContext
) => string | null | Promise<string | null>;

const MODEL_ID_GROUP_KEY = "__modelId__";

/**
 * Builds the single group resolver for a model.
 *
 * `groupKey` is sugar over `resolveGroup`, so both compile to one function and
 * the mutate path has exactly one way to resolve a group rather than two
 * branches that must be kept in step.
 */
const buildGroupResolver = (
  name: string,
  model: SyncModelConfig
): GroupResolver => {
  if (model.resolveGroup) {
    return model.resolveGroup;
  }

  if (model.groupKey === null) {
    return () => null;
  }

  if (model.groupKey === MODEL_ID_GROUP_KEY) {
    return ({ modelId }) => modelId;
  }

  const { groupKey } = model;

  return ({ action, modelId, payload, record }) => {
    const fromRecord = record?.[groupKey];
    if (action !== "I" && record) {
      if (typeof fromRecord === "string" && fromRecord.length > 0) {
        return fromRecord;
      }
      throw new Error("Invalid mutation: missing required group identifier");
    }

    const fromPayload = payload[groupKey];
    if (typeof fromPayload === "string" && fromPayload.length > 0) {
      return fromPayload;
    }

    if (action === "I") {
      throw new Error("Invalid mutation: missing required group identifier");
    }

    throw new Error(`Invalid mutation: record not found (${name}/${modelId})`);
  };
};

export interface ModelRegistry {
  handlers: Map<string, ModelHandler>;
  /** modelName -> the one function that decides a row's group. */
  groupResolvers: Record<string, GroupResolver>;
  /** modelName -> DB lookup, only for standard models with a resolvable idColumn. */
  delegates: Record<string, ModelLookup>;
  configs: Record<string, SyncModelConfig>;
}

const buildDelegate = (
  name: string,
  model: SyncModelConfig,
  delegates: Record<string, ModelLookup>
): void => {
  if (model.mutate.kind !== "standard") {
    return;
  }

  const idField = model.mutate.idField ?? "id";
  let idColumn: unknown;
  try {
    const cols = getTableColumns(model.table) as Record<string, unknown>;
    idColumn = cols[idField];
  } catch {
    // Table columns unavailable, skip delegate registration
  }

  if (idColumn) {
    delegates[name] = async (lookupDb, id) => {
      const typedDb = lookupDb as SyncDb;
      const rows = await typedDb
        .select()
        .from(model.table)
        .where(eq(idColumn as never, id))
        .limit(1);
      return (rows[0] as Record<string, unknown> | undefined) ?? null;
    };
  }
};

const buildHandler = (model: SyncModelConfig): ModelHandler => {
  const mutateConfig = model.mutate;
  const delegate: MutationDelegate =
    mutateConfig.kind === "standard"
      ? createStandardDelegate(model.table, mutateConfig.idField ?? "id")
      : createCompositeDelegate(model.table, mutateConfig.buildDeleteWhere);

  const def: ModelDef =
    mutateConfig.kind === "standard"
      ? {
          actions: mutateConfig.actions,
          delegate,
          insertFields: mutateConfig.insertFields,
          kind: "standard",
          onBeforeDelete: mutateConfig.onBeforeDelete,
          onBeforeInsert: mutateConfig.onBeforeInsert,
          onBeforeUpdate: mutateConfig.onBeforeUpdate,
          updateFields: mutateConfig.updateFields,
        }
      : {
          actions: mutateConfig.actions,
          delegate,
          insertFields: mutateConfig.insertFields,
          kind: "composite",
        };

  return createModelHandler(def);
};

/**
 * Builds the per-model lookup tables MutateService consumes: action handlers,
 * group keys, DB delegates, and the raw configs.
 */
export const buildModelRegistry = (
  models: Record<string, SyncModelConfig>
): ModelRegistry => {
  const handlers = new Map<string, ModelHandler>();
  const groupResolvers: Record<string, GroupResolver> = {};
  const delegates: Record<string, ModelLookup> = {};

  for (const [name, model] of Object.entries(models)) {
    // Fail at startup rather than inventing a groupType at write time: this
    // value lands in a table the consumer owns, so guessing it is not ours to
    // do.
    if (model.insertCreatesGroup && !model.groupType) {
      throw new Error(
        `Model "${name}" sets insertCreatesGroup but no groupType. ` +
          "groupType is written to sync_group_memberships and must be explicit."
      );
    }

    groupResolvers[name] = buildGroupResolver(name, model);
    buildDelegate(name, model, delegates);
    handlers.set(name, buildHandler(model));
  }

  return { configs: models, delegates, groupResolvers, handlers };
};
