import type { BatchLoadOptions, ModelRow } from "@stratasync/core";

import type { IdentityMapRegistry } from "./identity-map.js";
import type { SyncOrchestrator } from "./sync-orchestrator.js";
import type {
  ModelChangeAction,
  StorageAdapter,
  TransportAdapter,
} from "./types.js";
import { getModelKey } from "./utils.js";

/**
 * Collaborators the lazy loader needs from the client composition root.
 */
export interface LazyLoaderDeps {
  identityMaps: IdentityMapRegistry;
  storage: StorageAdapter;
  transport: TransportAdapter;
  orchestrator: SyncOrchestrator;
  /** Set of model keys known to be missing (shared with the client). */
  missingModels: Set<string>;
  runWithStateLock<T>(operation: () => Promise<T>): Promise<T>;
  materialize<T extends Record<string, unknown>>(
    modelName: string,
    id: string,
    data: T,
    options?: { preferCached?: boolean }
  ): T;
  emitModelChange(
    modelName: string,
    modelId: string,
    action: ModelChangeAction
  ): void;
}

/**
 * Owns lazy model loading: identity-map/storage fast paths, streaming
 * batch-load from the transport for `partial`/`lazy` models, and in-flight
 * dedupe so concurrent loads of the same key share one network round-trip.
 */
export class LazyLoader {
  private readonly deps: LazyLoaderDeps;
  private readonly pendingLoads = new Map<string, Promise<unknown | null>>();
  private readonly pendingIndexLoads = new Map<
    string,
    Promise<Record<string, unknown>[]>
  >();

  constructor(deps: LazyLoaderDeps) {
    this.deps = deps;
  }

  /** Clears all in-flight load dedupe state. */
  clear(): void {
    this.pendingLoads.clear();
    this.pendingIndexLoads.clear();
  }

  private createBatchLoadStream(
    requests: BatchLoadOptions["requests"]
  ): ReturnType<TransportAdapter["batchLoad"]> {
    return this.deps.transport.batchLoad({
      firstSyncId: this.deps.orchestrator.getFirstSyncId(),
      requests,
    });
  }

  private processBatchLoadRow(row: ModelRow): Promise<string | undefined> {
    return this.deps.runWithStateLock(async () => {
      const rowPrimaryKey = this.deps.orchestrator
        .getRegistry()
        .getPrimaryKey(row.modelName);
      const rowId = row.data[rowPrimaryKey] as string;
      if (typeof rowId !== "string") {
        return;
      }
      await this.deps.storage.put(row.modelName, row.data);
      const rowMap = this.deps.identityMaps.getMap<Record<string, unknown>>(
        row.modelName
      );
      const existed = rowMap.has(rowId);
      rowMap.merge(rowId, row.data, { serialized: true });
      this.deps.emitModelChange(
        row.modelName,
        rowId,
        existed ? "update" : "insert"
      );
      return rowId;
    });
  }

  async ensureModel<T>(modelName: string, id: string): Promise<T | null> {
    const map = this.deps.identityMaps.getMap<T & Record<string, unknown>>(
      modelName
    );
    const cached = map.get(id);
    if (cached) {
      return cached as T;
    }

    const stored = await this.deps.storage.get<T>(modelName, id);
    if (stored) {
      map.set(id, stored as T & Record<string, unknown>, { serialized: true });
      const key = getModelKey(modelName, id);
      this.deps.missingModels.delete(key);
      return this.deps.materialize(
        modelName,
        id,
        stored as T & Record<string, unknown>
      );
    }

    const model = this.deps.orchestrator
      .getRegistry()
      .getModelMetadata(modelName);
    if (!model) {
      return null;
    }

    const loadStrategy = model.loadStrategy ?? "instant";
    if (loadStrategy === "instant" || loadStrategy === "local") {
      const key = getModelKey(modelName, id);
      this.deps.missingModels.add(key);
      return null;
    }

    const key = getModelKey(modelName, id);
    const pending = this.pendingLoads.get(key);
    if (pending) {
      return pending as Promise<T | null>;
    }

    const loadPromise = (async () => {
      let found: T | null = null;
      const primaryKey = this.deps.orchestrator
        .getRegistry()
        .getPrimaryKey(modelName);
      const stream = this.createBatchLoadStream([
        {
          indexedKey: primaryKey,
          keyValue: id,
          modelName,
        },
      ]);

      for await (const row of stream) {
        const rowId = await this.processBatchLoadRow(row);
        if (row.modelName === modelName && rowId === id) {
          found = this.deps.materialize(
            modelName,
            id,
            row.data as T & Record<string, unknown>
          );
        }
      }

      if (found) {
        this.deps.missingModels.delete(key);
      } else {
        this.deps.missingModels.add(key);
      }

      return found;
    })();

    this.pendingLoads.set(key, loadPromise);

    try {
      return await loadPromise;
    } finally {
      this.pendingLoads.delete(key);
    }
  }

  async loadByIndex<T extends Record<string, unknown>>(
    modelName: string,
    indexedKey: string,
    keyValue: string
  ): Promise<T[]> {
    const model = this.deps.orchestrator
      .getRegistry()
      .getModelMetadata(modelName);
    const isPartial = model?.loadStrategy === "partial";

    if (!isPartial) {
      return this.deps.storage.getByIndex<T>(modelName, indexedKey, keyValue);
    }

    const hasIndex = await this.deps.storage.hasPartialIndex(
      modelName,
      indexedKey,
      keyValue
    );

    if (hasIndex) {
      return this.deps.storage.getByIndex<T>(modelName, indexedKey, keyValue);
    }

    const loadKey = `${modelName}:${indexedKey}:${keyValue}`;
    const pending = this.pendingIndexLoads.get(loadKey);
    if (pending) {
      return pending as Promise<T[]>;
    }

    const loadPromise = (async () => {
      const stream = this.createBatchLoadStream([
        {
          indexedKey,
          keyValue,
          modelName,
        },
      ]);

      for await (const row of stream) {
        await this.processBatchLoadRow(row);
      }

      await this.deps.storage.setPartialIndex(modelName, indexedKey, keyValue);
      return this.deps.storage.getByIndex<T>(modelName, indexedKey, keyValue);
    })();

    this.pendingIndexLoads.set(loadKey, loadPromise);

    try {
      return await loadPromise;
    } finally {
      this.pendingIndexLoads.delete(loadKey);
    }
  }
}
