import { eq, getTableColumns } from "drizzle-orm";

import type { SyncModelConfig } from "../config.js";
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

export interface ModelRegistry {
  handlers: Map<string, ModelHandler>;
  /** modelName -> groupKey, only for models with a non-null groupKey. */
  groupKeys: Record<string, string>;
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
  const groupKeys: Record<string, string> = {};
  const delegates: Record<string, ModelLookup> = {};

  for (const [name, model] of Object.entries(models)) {
    if (model.groupKey !== null) {
      groupKeys[name] = model.groupKey;
    }

    buildDelegate(name, model, delegates);
    handlers.set(name, buildHandler(model));
  }

  return { configs: models, delegates, groupKeys, handlers };
};
