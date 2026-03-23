import type { Model } from "@stratasync/core";

import { DIRTY_TRACKER } from "./dirty-tracking.js";

const isPlainObject = function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
};

const isDeepEqual = function isDeepEqual(
  left: unknown,
  right: unknown
): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }

    for (let index = 0; index < left.length; index += 1) {
      if (!isDeepEqual(left[index], right[index])) {
        return false;
      }
    }

    return true;
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    for (const key of leftKeys) {
      if (!Object.hasOwn(right, key) || !isDeepEqual(left[key], right[key])) {
        return false;
      }
    }

    return true;
  }

  return false;
};

/**
 * Returns a plain JavaScript object from a model instance.
 * Copies all __data properties plus the id.
 * Useful when spread operator doesn't copy prototype getters.
 */
export const toPlainObject = function toPlainObject<T extends Model>(
  model: T
): Record<string, unknown> {
  const result: Record<string, unknown> = { id: model.id };
  const data = model.__data;
  for (const key of Object.keys(data)) {
    result[key] = data[key];
  }
  return result;
};

/**
 * Creates a shallow clone of a model's data for comparison or form editing.
 */
export const cloneModelData = function cloneModelData<T extends Model>(
  model: T
): Record<string, unknown> {
  return { ...toPlainObject(model) };
};

/**
 * Compares two model instances' data and returns changed fields.
 */
export const diffModels = function diffModels<T extends Model>(
  a: T,
  b: T
): Record<string, { old: unknown; new: unknown }> {
  const result: Record<string, { old: unknown; new: unknown }> = {};
  const aData = a.__data;
  const bData = b.__data;
  const allKeys = new Set([...Object.keys(aData), ...Object.keys(bData)]);
  for (const key of allKeys) {
    if (!isDeepEqual(aData[key], bData[key])) {
      result[key] = { new: bData[key], old: aData[key] };
    }
  }
  return result;
};

/**
 * Returns true if the model has any unsaved changes.
 * Reads from the DirtyTracker if one is attached, otherwise falls back to changeSnapshot().
 */
export const isModelDirty = function isModelDirty(model: Model): boolean {
  const tracker = (model as unknown as Record<symbol, unknown>)[
    DIRTY_TRACKER
  ] as { isDirty: boolean } | undefined;
  if (tracker) {
    return tracker.isDirty;
  }
  const snapshot = model.changeSnapshot();
  return Object.keys(snapshot.changes).length > 0;
};
