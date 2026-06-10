import type { BootstrapMetadata, ModelRow } from "@stratasync/core";
import { ZERO_SYNC_ID } from "@stratasync/core";

import type { StorageMeta } from "../types.js";
import type { SyncContext } from "./context.js";

/**
 * Owns bootstrap: deciding whether a full bootstrap is required, streaming and
 * committing the snapshot, hydrating identity maps from local storage, and the
 * auto/local/full mode strategy. The orchestrator owns the run token and passes
 * it down; the runner only reads it via the context (no token of its own).
 */
export class BootstrapRunner {
  private readonly ctx: SyncContext;

  constructor(ctx: SyncContext) {
    this.ctx = ctx;
  }

  private shouldAbort(runToken: number): boolean {
    return !this.ctx.isRunActive(runToken);
  }

  async bootstrapIfNeeded(meta: StorageMeta, runToken: number): Promise<void> {
    if ((this.ctx.options.bootstrapMode ?? "auto") === "full") {
      await this.bootstrap(runToken);
      return;
    }

    const needsBootstrap = await this.shouldBootstrap(meta);
    if (!needsBootstrap) {
      await this.hydrateIdentityMaps(runToken);
      return;
    }

    await this.runBootstrapStrategy(runToken);
  }

  async shouldBootstrap(meta: StorageMeta): Promise<boolean> {
    const bootstrapModels = this.ctx.registry.getBootstrapModelNames();
    const arePersisted = await this.areModelsPersisted(bootstrapModels);
    const storedHash = meta.schemaHash ?? "";
    // Treat an empty/missing hash as a mismatch. A valid bootstrap always
    // writes the hash, so an empty value means prior state is corrupt.
    const hasSchemaMismatch =
      storedHash.length === 0 || storedHash !== this.ctx.schemaHash;

    return (
      meta.bootstrapComplete === false ||
      hasSchemaMismatch ||
      this.ctx.cursor.lastSyncId === ZERO_SYNC_ID ||
      !arePersisted
    );
  }

  private async runBootstrapStrategy(runToken: number): Promise<void> {
    const bootstrapMode = this.ctx.options.bootstrapMode ?? "auto";
    if (bootstrapMode === "local") {
      await this.localBootstrap(runToken);
      return;
    }

    try {
      await this.bootstrap(runToken);
    } catch (error) {
      const canFallback =
        bootstrapMode === "auto" && (await this.hasLocalData());
      if (canFallback) {
        await this.localBootstrap(runToken);
        return;
      }
      throw error;
    }
  }

  /**
   * Performs initial bootstrap.
   */
  async bootstrap(runToken: number): Promise<void> {
    this.ctx.setState("bootstrapping");

    // Stream bootstrap data
    const iterator = this.ctx.transport.bootstrap({
      onlyModels: this.ctx.registry.getBootstrapModelNames(),
      schemaHash: this.ctx.schemaHash,
      syncGroups: this.ctx.getGroups(),
      type: "full",
    });

    const snapshot = await this.readBootstrapStream(iterator, runToken);
    if (!snapshot) {
      return;
    }
    if (this.shouldAbort(runToken)) {
      return;
    }

    await this.commitBootstrapRows(snapshot.rows);

    const databaseVersion = this.applyBootstrapMetadata(snapshot.metadata);

    const persisted = await this.markBootstrapModelsPersisted(runToken);
    if (!persisted) {
      return;
    }

    await this.ctx.storage.setMeta({
      bootstrapComplete: true,
      databaseVersion,
      firstSyncId: this.ctx.cursor.firstSyncId,
      lastSyncAt: Date.now(),
      lastSyncId: this.ctx.cursor.lastSyncId,
      schemaHash: this.ctx.schemaHash,
      subscribedSyncGroups: this.ctx.getGroups(),
      updatedAt: Date.now(),
    });
    this.ctx.emitEvent?.({
      lastSyncId: this.ctx.cursor.lastSyncId,
      type: "syncComplete",
    });
  }

  private async readBootstrapStream(
    iterator: AsyncGenerator<ModelRow, BootstrapMetadata, unknown>,
    runToken: number
  ): Promise<{
    metadata: BootstrapMetadata;
    rows: ModelRow[];
  } | null> {
    const rows: ModelRow[] = [];
    while (true) {
      const { value, done } = await iterator.next();
      if (this.shouldAbort(runToken)) {
        return null;
      }

      if (done) {
        if (!value) {
          throw new Error("Bootstrap completed without metadata");
        }
        return { metadata: value, rows };
      }

      rows.push(value);
    }
  }

  private async commitBootstrapRows(rows: ModelRow[]): Promise<void> {
    const ops = rows.map((row) => ({
      data: row.data,
      modelName: row.modelName,
      type: "put" as const,
    }));

    await this.ctx.storage.clear({ preserveOutbox: true });
    if (ops.length > 0) {
      await this.ctx.storage.writeBatch(ops);
    }

    this.ctx.identityMaps.batch(() => {
      this.ctx.identityMaps.clearAll();
      for (const row of rows) {
        const primaryKey = this.ctx.registry.getPrimaryKey(row.modelName);
        const id = row.data[primaryKey] as string;
        if (typeof id !== "string") {
          continue;
        }

        const map = this.ctx.identityMaps.getMap(row.modelName);
        map.set(id, row.data, { serialized: true });
      }
    });
  }

  private applyBootstrapMetadata(
    metadata: BootstrapMetadata
  ): number | undefined {
    if (metadata.lastSyncId === undefined) {
      throw new Error("Bootstrap metadata is missing lastSyncId");
    }

    this.ctx.cursor.setFromBootstrap(metadata.lastSyncId);
    this.ctx.setGroups(
      (metadata.subscribedSyncGroups?.length ?? 0) > 0
        ? metadata.subscribedSyncGroups
        : this.ctx.getGroups()
    );

    return metadata.databaseVersion;
  }

  private async markBootstrapModelsPersisted(
    runToken: number
  ): Promise<boolean> {
    for (const modelName of this.ctx.registry.getBootstrapModelNames()) {
      await this.ctx.storage.setModelPersistence(modelName, true);
      if (this.shouldAbort(runToken)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Performs a local-only bootstrap using existing storage data.
   */
  private async localBootstrap(runToken: number): Promise<void> {
    this.ctx.setState("bootstrapping");
    await this.hydrateIdentityMaps(runToken);
  }

  /**
   * Checks whether any hydrated models exist in storage.
   */
  private async hasLocalData(): Promise<boolean> {
    for (const modelName of this.ctx.registry.getBootstrapModelNames()) {
      const count = await this.ctx.storage.count(modelName);
      if (count > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Loads existing data from storage into identity maps.
   */
  async hydrateIdentityMaps(runToken: number): Promise<void> {
    for (const modelName of this.ctx.registry.getEagerHydrationModelNames()) {
      if (!this.ctx.isRunActive(runToken)) {
        return;
      }
      const rows =
        await this.ctx.storage.getAll<Record<string, unknown>>(modelName);
      if (!this.ctx.isRunActive(runToken)) {
        return;
      }
      const map = this.ctx.identityMaps.getMap(modelName);
      const primaryKey = this.ctx.registry.getPrimaryKey(modelName);

      for (const row of rows) {
        if (!this.ctx.isRunActive(runToken)) {
          return;
        }
        const id = row[primaryKey] as string;
        if (typeof id !== "string") {
          continue;
        }
        map.set(id, row, { serialized: true });
      }
    }
  }

  private async areModelsPersisted(modelNames: string[]): Promise<boolean> {
    for (const modelName of modelNames) {
      const persistence = await this.ctx.storage.getModelPersistence(modelName);
      if (!persistence.persisted) {
        return false;
      }
    }
    return true;
  }
}
