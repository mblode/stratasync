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
  /** Remove tracker hooks from the model */
  dispose(): void;
}

// Symbol to store tracker on model instances
export const DIRTY_TRACKER = Symbol.for("done:dirty-tracker");

const getTrackedFields = function getTrackedFields(model: Model): string[] {
  return Object.keys(model.changeSnapshot().changes);
};

export const getDirtyTracker = function getDirtyTracker(
  model: Model
): DirtyTracker | undefined {
  return (model as unknown as Record<symbol, unknown>)[DIRTY_TRACKER] as
    | DirtyTracker
    | undefined;
};

export const createDirtyTracker = function createDirtyTracker(
  model: Model
): DirtyTracker {
  // Check if already attached
  const existing = getDirtyTracker(model);
  if (existing) {
    return existing;
  }

  // Create an observable set to mirror modified property names
  const fields = observable.set<string>(getTrackedFields(model));
  let disposed = false;

  const syncField = function syncField(name: string): void {
    const trackedFields = getTrackedFields(model);
    runInAction(() => {
      if (trackedFields.includes(name)) {
        fields.add(name);
        return;
      }
      fields.delete(name);
    });
  };

  // Wrap markPropertyChanged to track fields.
  // We wrap markPropertyChanged (not propertyChanged) so that _applyUpdate,
  // which suppresses tracking via suppressTracking counter, does not mark dirty.
  const originalMarkPropertyChanged = model.markPropertyChanged;
  model.markPropertyChanged = (
    name: string,
    oldValue: unknown,
    newValue: unknown
  ) => {
    originalMarkPropertyChanged.call(model, name, oldValue, newValue);
    syncField(name);
  };

  // Wrap clearChanges to reset tracking
  const originalClearChanges = model.clearChanges;
  model.clearChanges = () => {
    originalClearChanges.call(model);
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
    dispose() {
      if (disposed) {
        return;
      }

      model.markPropertyChanged = originalMarkPropertyChanged;
      model.clearChanges = originalClearChanges;
      runInAction(() => {
        fields.clear();
      });
      (model as unknown as Record<symbol, unknown>)[DIRTY_TRACKER] = undefined;
      disposed = true;
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
