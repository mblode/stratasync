import type { Model } from "@stratasync/core";
import { computed, observable, runInAction } from "mobx";

export interface DirtyTracker {
  /** Observable: true if any properties have been modified since last save/clear */
  readonly isDirty: boolean;
  /** Observable: set of property names that have been modified */
  readonly modifiedFields: ReadonlySet<string>;
  /** Observable: count of modified fields */
  readonly modifiedCount: number;
  /** Reset tracking */
  clear(): void;
}

// Symbol to store tracker on model instances
const DIRTY_TRACKER = Symbol.for("done:dirty-tracker");

export const getDirtyTracker = (model: Model): DirtyTracker | undefined =>
  (model as unknown as Record<symbol, unknown>)[DIRTY_TRACKER] as
    | DirtyTracker
    | undefined;

export const createDirtyTracker = (model: Model): DirtyTracker => {
  // Check if already attached
  const existing = getDirtyTracker(model);
  if (existing) {
    return existing;
  }

  // Create an observable set to mirror modified property names
  const fields = observable.set<string>();

  // Wrap markPropertyChanged to track fields.
  // We wrap markPropertyChanged (not propertyChanged) so that _applyUpdate,
  // which suppresses tracking via suppressTracking counter, does not mark dirty.
  const originalMarkPropertyChanged = model.markPropertyChanged.bind(model);
  model.markPropertyChanged = (
    name: string,
    oldValue: unknown,
    newValue: unknown
  ) => {
    originalMarkPropertyChanged(name, oldValue, newValue);
    runInAction(() => {
      fields.add(name);
    });
  };

  // Wrap clearChanges to reset tracking
  const originalClearChanges = model.clearChanges.bind(model);
  model.clearChanges = () => {
    originalClearChanges();
    runInAction(() => {
      fields.clear();
    });
  };

  const isDirtyComputed = computed(() => fields.size > 0);
  const modifiedCountComputed = computed(() => fields.size);

  const tracker: DirtyTracker = {
    clear() {
      model.clearChanges();
    },
    get isDirty() {
      return isDirtyComputed.get();
    },
    get modifiedCount() {
      return modifiedCountComputed.get();
    },
    get modifiedFields() {
      return fields;
    },
  };

  // Attach to model
  (model as unknown as Record<symbol, unknown>)[DIRTY_TRACKER] = tracker;
  return tracker;
};
