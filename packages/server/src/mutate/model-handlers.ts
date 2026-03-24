import { eq } from "drizzle-orm";
import type { InferInsertModel, SQL } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";

import type { ModelAction, SyncUserContext } from "../types.js";
import { getColumn } from "../utils/sync-utils.js";
import { handleArchiveMutation } from "./archive-mutation.js";
import type { FieldSpec } from "./field-codecs.js";
import {
  buildInsertData,
  buildUpdateData,
  serializeSyncData,
} from "./field-codecs.js";
import { assertMutationTargetAffected } from "./write-results.js";

// ---------------------------------------------------------------------------
// Drizzle mutation delegates
// ---------------------------------------------------------------------------

export interface MutationDelegate {
  insert: (db: unknown, data: Record<string, unknown>) => Promise<void>;
  updateById?: (
    db: unknown,
    id: string,
    data: Record<string, unknown>
  ) => Promise<unknown>;
  deleteById?: (db: unknown, id: string) => Promise<unknown>;
  deleteByPayload?: (
    db: unknown,
    payload: Record<string, unknown>
  ) => Promise<unknown>;
}

export const createStandardDelegate = <TTable extends AnyPgTable>(
  table: TTable,
  idField: string
): MutationDelegate => {
  const idColumn = getColumn(table, idField);

  return {
    deleteById: async (db, id) =>
      await (
        db as { delete(t: AnyPgTable): { where(c: unknown): Promise<unknown> } }
      )
        .delete(table)
        .where(eq(idColumn, id)),
    insert: async (db, data) => {
      await (
        db as {
          insert(t: AnyPgTable): { values(d: unknown): Promise<unknown> };
        }
      )
        .insert(table)
        .values(data as InferInsertModel<TTable>);
    },
    updateById: async (db, id, data) =>
      await (
        db as {
          update(t: AnyPgTable): {
            set(d: unknown): { where(c: unknown): Promise<unknown> };
          };
        }
      )
        .update(table)
        .set(data as Partial<InferInsertModel<TTable>>)
        .where(eq(idColumn, id)),
  };
};

export const createCompositeDelegate = <TTable extends AnyPgTable>(
  table: TTable,
  buildDeleteWhere: (payload: Record<string, unknown>) => SQL<unknown>
): MutationDelegate => ({
  deleteByPayload: async (db, payload) =>
    await (
      db as { delete(t: AnyPgTable): { where(c: unknown): Promise<unknown> } }
    )
      .delete(table)
      .where(buildDeleteWhere(payload)),
  insert: async (db, data) => {
    await (
      db as { insert(t: AnyPgTable): { values(d: unknown): Promise<unknown> } }
    )
      .insert(table)
      .values(data as InferInsertModel<TTable>);
  },
});

// ---------------------------------------------------------------------------
// Declarative model definition types
// ---------------------------------------------------------------------------

export interface StandardModelDef {
  kind: "standard";
  delegate: MutationDelegate;
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
}

export interface CompositeModelDef {
  kind: "composite";
  delegate: MutationDelegate;
  actions: Set<ModelAction>;
  insertFields: Record<string, FieldSpec>;
}

export type ModelDef = StandardModelDef | CompositeModelDef;

// ---------------------------------------------------------------------------
// Generic handler factory
// ---------------------------------------------------------------------------

type ModelHandler = (
  db: unknown,
  modelId: string,
  payload: Record<string, unknown>,
  action: ModelAction,
  context?: SyncUserContext
) => Promise<Record<string, unknown>>;

const handleInsert = async (
  db: unknown,
  def: ModelDef,
  modelId: string,
  payload: Record<string, unknown>,
  context?: SyncUserContext
): Promise<Record<string, unknown>> => {
  const hasId = def.kind === "standard";
  let data = buildInsertData(hasId ? modelId : null, payload, def.insertFields);

  if (def.kind === "standard" && def.onBeforeInsert) {
    data = await def.onBeforeInsert(db, modelId, payload, data, context);
  }

  await def.delegate.insert(db, data);
  return serializeSyncData(data, def.insertFields, {
    modelId: hasId ? modelId : null,
  });
};

const handleUpdate = async (
  db: unknown,
  def: ModelDef,
  modelId: string,
  payload: Record<string, unknown>,
  context?: SyncUserContext
): Promise<Record<string, unknown>> => {
  if (def.kind !== "standard" || !def.updateFields) {
    throw new Error("Update not configured for this model");
  }

  if (!def.delegate.updateById) {
    throw new Error("Update delegate missing for this model");
  }

  let updateData = buildUpdateData(payload, def.updateFields, def.insertFields);

  if (def.onBeforeUpdate) {
    updateData = await def.onBeforeUpdate(db, modelId, payload, updateData, context);
  }

  if (Object.keys(updateData).length === 0) {
    return {};
  }

  const updateResult = await def.delegate.updateById(db, modelId, updateData);
  assertMutationTargetAffected(updateResult);
  return serializeSyncData(updateData, def.insertFields, {
    keys: Object.keys(updateData),
  });
};

const handleDelete = async (
  db: unknown,
  def: ModelDef,
  modelId: string,
  payload: Record<string, unknown>,
  context?: SyncUserContext
): Promise<Record<string, unknown>> => {
  if (def.kind === "standard" && def.onBeforeDelete) {
    await def.onBeforeDelete(db, modelId, payload, context);
  }
  if (def.kind === "composite") {
    if (!def.delegate.deleteByPayload) {
      throw new Error("Composite delete delegate missing for this model");
    }
    const deleteResult = await def.delegate.deleteByPayload(db, payload);
    assertMutationTargetAffected(deleteResult);
    return payload;
  }

  if (!def.delegate.deleteById) {
    throw new Error("Delete delegate missing for this model");
  }

  const deleteResult = await def.delegate.deleteById(db, modelId);
  assertMutationTargetAffected(deleteResult);
  return payload;
};

const getStandardUpdateDelegate = (
  def: StandardModelDef,
  actionLabel: string
): NonNullable<MutationDelegate["updateById"]> => {
  if (!def.delegate.updateById) {
    throw new Error(`${actionLabel} delegate missing for this model`);
  }
  return def.delegate.updateById;
};

export const createModelHandler =
  (def: ModelDef): ModelHandler =>
  (db, modelId, payload, action, context) => {
    if (!def.actions.has(action)) {
      throw new Error(`Unsupported action "${action}" for this model`);
    }

    switch (action) {
      case "I": {
        return handleInsert(db, def, modelId, payload, context);
      }
      case "U": {
        return handleUpdate(db, def, modelId, payload, context);
      }
      case "D": {
        return handleDelete(db, def, modelId, payload, context);
      }
      case "A": {
        if (def.kind !== "standard") {
          throw new Error("Archive not configured for this model");
        }
        return handleArchiveMutation({
          action: "A",
          db,
          modelId,
          payload,
          updateById: getStandardUpdateDelegate(def, "Archive"),
        });
      }
      case "V": {
        if (def.kind !== "standard") {
          throw new Error("Unarchive not configured for this model");
        }
        return handleArchiveMutation({
          action: "V",
          db,
          modelId,
          payload,
          updateById: getStandardUpdateDelegate(def, "Unarchive"),
        });
      }
      default: {
        throw new Error(`Unknown action: ${action}`);
      }
    }
  };
