import type { Model } from "@stratasync/core";
import { computed } from "mobx";

/**
 * Creates a MobX computed value that resolves a foreign key reference.
 * The model must have a store attached.
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
export const computedReference = <T>(
  model: Model,
  foreignKeyField: string,
  targetModelName: string
): { get(): T | null } =>
  computed(() => {
    const id = model.__data[foreignKeyField];
    if (typeof id !== "string" || !model.store) {
      return null;
    }
    return (model.store.get(targetModelName, id) as T) ?? null;
  });

/**
 * Creates a MobX computed value for a reverse relation (one-to-many).
 * Returns models of targetModelName where foreignKey matches model.id.
 *
 * Requires a `getAll` method on the store. If the store does not have `getAll`,
 * the computed always returns an empty array.
 *
 * @example
 * ```ts
 * const comments = computedCollection<Comment>(task, 'Comment', 'taskId');
 * const commentCount = comments.get().length;
 * updateCommentBadge(commentCount);
 * ```
 */
export const computedCollection = <T>(
  model: Model,
  targetModelName: string,
  foreignKey: string
): { get(): T[] } =>
  computed(() => {
    const store = model.store as
      | (typeof model.store & {
          getAll?: (modelName: string) => unknown[];
        })
      | undefined;
    if (!store?.getAll) {
      return [];
    }
    const all = store.getAll(targetModelName) as (T & Model)[];
    return all.filter((item) => item.__data[foreignKey] === model.id);
  });
