import { ModelRegistry } from "../schema/registry.js";
import type { ModelConstructor } from "../schema/types.js";
import type { SyncStore } from "../store/types.js";
import {
  captureArchiveState,
  createArchivePayload,
} from "../transaction/archive.js";
import { CachedPromise } from "./cached-promise.js";
import type { Hydrated } from "./hydration.js";

export interface ChangeSnapshot {
  changes: Record<string, unknown>;
  original: Record<string, unknown>;
}

/**
 * Base model class for Done models.
 */
export class Model {
  // ── Tracking infrastructure (must initialize before any decorated field) ──
  private readonly modifiedProperties = new Map<string, unknown>();
  private suppressTracking = 0;
  private __cachedModelName?: string;

  /** Primary key (uuid) */
  id = "";
  /** Whether lazy references have been hydrated */
  hydrated = false;
  /** MobX boxes for observable properties */
  _mobx: Record<string, { get(): unknown; set(value: unknown): void }> = {};
  /** Backing data store */
  __data: Record<string, unknown> = {};
  /** Store reference */
  store?: SyncStore;

  /**
   * Returns the registered model name (cached after first access).
   */
  get __modelName(): string {
    if (this.__cachedModelName !== undefined) {
      return this.__cachedModelName;
    }
    const name = ModelRegistry.getModelName(
      this.constructor as ModelConstructor
    );
    this.__cachedModelName =
      name ?? (this.constructor as { name?: string }).name ?? "Model";
    return this.__cachedModelName;
  }

  /**
   * Makes this model observable (placeholder for MobX integration).
   * Subclasses override this to wire up MobX reactivity.
   */
  // oxlint-disable-next-line eslint(class-methods-use-this) -- override hook for subclasses
  makeObservable(): void {
    // Observability is handled per-property via decorators.
  }

  /**
   * Hydrates lazy references and collections for this model.
   */
  async hydrate(): Promise<Hydrated<this>> {
    if (this.hydrated) {
      return this as Hydrated<this>;
    }

    const referenced = ModelRegistry.getReferencedProperties(this.__modelName);
    const pending: Promise<unknown>[] = [];

    for (const [propertyName, meta] of referenced.entries()) {
      const value = (this as Record<string, unknown>)[propertyName];
      if (!value) {
        continue;
      }

      if (meta.type === "referenceModel") {
        if (value instanceof CachedPromise) {
          pending.push(value.getPromise());
          continue;
        }
        if (value instanceof Promise) {
          pending.push(value as Promise<unknown>);
        }
        continue;
      }

      if (meta.type === "referenceCollection") {
        const hydrator = value as { hydrate?: () => Promise<unknown> };
        if (typeof hydrator.hydrate === "function") {
          pending.push(hydrator.hydrate());
        }
      }
    }

    if (pending.length > 0) {
      await Promise.all(pending);
    }

    this.hydrated = true;
    return this as Hydrated<this>;
  }

  /**
   * Tracks property changes for transaction creation.
   */
  propertyChanged(
    propertyName: string,
    oldValue: unknown,
    newValue: unknown
  ): void {
    if (!this.modifiedProperties || this.suppressTracking > 0) {
      return;
    }
    this.markPropertyChanged(propertyName, oldValue, newValue);
  }

  /**
   * Records the original value for a changed property.
   */
  markPropertyChanged(
    propertyName: string,
    oldValue: unknown,
    _newValue: unknown
  ): void {
    if (this.modifiedProperties.has(propertyName)) {
      return;
    }

    const meta = ModelRegistry.getModelProperties(this.__modelName).get(
      propertyName
    );
    const serializer = meta?.serializer;
    const serializedOldValue = serializer
      ? serializer.serialize(oldValue)
      : oldValue;
    this.modifiedProperties.set(propertyName, serializedOldValue);
  }

  /**
   * Creates a snapshot of changes for UpdateTransaction creation.
   */
  changeSnapshot(): ChangeSnapshot {
    const changes: Record<string, unknown> = {};
    const original: Record<string, unknown> = {};

    for (const [propertyName, oldValue] of this.modifiedProperties.entries()) {
      original[propertyName] = oldValue;
      changes[propertyName] = this.__data[propertyName];
    }

    return { changes, original };
  }

  /**
   * Clears tracked property changes.
   */
  clearChanges(): void {
    this.modifiedProperties.clear();
  }

  /**
   * Applies updates without recording change tracking.
   */
  _applyUpdate(changes: Record<string, unknown>): void {
    this.withSuppressedTracking(() => {
      for (const [key, value] of Object.entries(changes)) {
        if (key === "id" && typeof value === "string") {
          this.id = value;
        }
        const current = this.__data[key];
        if (!Object.is(current, value)) {
          (this as Record<string, unknown>)[key] = value;
          this.__data[key] = value;
        }
      }
    });
  }

  /**
   * Serializes model data for persistence.
   */
  toJSON(): Record<string, unknown> {
    const data = { ...this.__data };
    if (this.id) {
      data.id = this.id;
    }
    return data;
  }

  /**
   * Saves pending changes by creating an update transaction.
   */
  async save(): Promise<void> {
    if (!this.store) {
      throw new Error("Model store is not configured");
    }

    if (!this.id) {
      if (!this.store.create) {
        throw new Error("Model store does not support create");
      }
      const created = await this.store.create(this.__modelName, this.toJSON());
      this._applyUpdate(created);
      this.clearChanges();
      return;
    }

    const snapshot = this.changeSnapshot();
    if (Object.keys(snapshot.changes).length === 0) {
      return;
    }

    if (!this.store.update) {
      throw new Error("Model store does not support update");
    }

    await this.store.update(this.__modelName, this.id, snapshot.changes, {
      original: snapshot.original,
    });
    this.clearChanges();
  }

  /**
   * Deletes this model.
   */
  async delete(): Promise<void> {
    if (!this.store?.delete) {
      throw new Error("Model store does not support delete");
    }
    await this.store.delete(this.__modelName, this.id, {
      original: this.toJSON(),
    });
  }

  /**
   * Archives this model.
   */
  async archive(): Promise<void> {
    if (!this.store?.archive) {
      throw new Error("Model store does not support archive");
    }
    await this.store.archive(this.__modelName, this.id, {
      archivedAt: createArchivePayload().archivedAt ?? undefined,
      original: captureArchiveState(this.__data),
    });
  }

  /**
   * Unarchives this model.
   */
  async unarchive(): Promise<void> {
    if (!this.store?.unarchive) {
      throw new Error("Model store does not support unarchive");
    }
    await this.store.unarchive(this.__modelName, this.id, {
      original: captureArchiveState(this.__data),
    });
  }

  private withSuppressedTracking(fn: () => void): void {
    this.suppressTracking += 1;
    try {
      fn();
    } finally {
      this.suppressTracking -= 1;
    }
  }
}
