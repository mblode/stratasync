import type { Model } from "@stratasync/core";
import { computed } from "mobx";

interface RelationStore {
  get: (modelName: string, id: string) => unknown | Promise<unknown>;
  getCached?: (modelName: string, id: string) => unknown | null;
  getAll?: (modelName: string) => unknown[] | Promise<unknown[]>;
}

const getModelFieldValue = function getModelFieldValue(
  model: Model,
  fieldName: string
): unknown {
  const instance = model as unknown as Record<string, unknown>;
  if (fieldName in instance) {
    return instance[fieldName];
  }
  return model.__data[fieldName];
};

const getCachedReference = function getCachedReference<T>(
  store: RelationStore,
  targetModelName: string,
  id: string
): T | null {
  const cached = store.getCached?.(targetModelName, id);
  if (cached !== undefined) {
    return (cached as T | null) ?? null;
  }

  const result = store.get(targetModelName, id);
  if (result instanceof Promise) {
    return null;
  }
  return (result as T | null) ?? null;
};

/**
 * Creates a MobX computed value that resolves a foreign key reference.
 * The model must have a store attached.
 * Call this once and memoize the result rather than creating a new computed on every render.
 *
 * @example
 * ```ts
 * const team = computedReference<Team>(task, 'teamId', 'Team');
 * const currentTeam = team.get();
 * if (currentTeam) {
 *   renderTeamName(currentTeam.name);
 * }
 * ```
 */
export const computedReference = function computedReference<T>(
  model: Model,
  foreignKeyField: string,
  targetModelName: string
): { get(): T | null } {
  return computed(() => {
    const id = getModelFieldValue(model, foreignKeyField);
    const store = model.store as RelationStore | undefined;
    if (typeof id !== "string" || !store) {
      return null;
    }
    return getCachedReference<T>(store, targetModelName, id);
  });
};

/**
 * Creates a MobX computed value for a reverse relation (one-to-many).
 * Returns models of targetModelName where foreignKey matches model.id.
 *
 * Requires a synchronous `getAll` method on the store. If the store does not have `getAll`,
 * or returns an async result, the computed returns an empty array.
 * Call this once and memoize the result rather than creating a new computed on every render.
 *
 * @example
 * ```ts
 * const comments = computedCollection<Comment>(task, 'Comment', 'taskId');
 * const commentCount = comments.get().length;
 * updateCommentBadge(commentCount);
 * ```
 */
export const computedCollection = function computedCollection<T>(
  model: Model,
  targetModelName: string,
  foreignKey: string
): { get(): T[] } {
  return computed(() => {
    const store = model.store as RelationStore | undefined;
    if (!store?.getAll) {
      return [];
    }

    const all = store.getAll(targetModelName);
    if (all instanceof Promise) {
      return [];
    }

    return (all as (T & Model)[]).filter(
      (item) => getModelFieldValue(item, foreignKey) === model.id
    );
  });
};
