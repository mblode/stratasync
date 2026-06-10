import type { SyncAction, SyncId, Transaction } from "@stratasync/core";

import type { SyncContext } from "./context.js";
import {
  applyPendingTransactionsToIdentityMaps,
  areGroupsEqual,
  touchPendingTransactionTargets,
} from "./pending-hydration.js";

/**
 * Owns sync-group membership changes that arrive as delta actions: diffing the
 * current groups against the server's new set, partial-bootstrapping added
 * groups, dropping data for removed groups, persisting the new floor, and
 * restarting the delta subscription at the change syncId.
 */
export class SyncGroupManager {
  private readonly ctx: SyncContext;
  private readonly restartSubscription: (afterSyncId: SyncId) => Promise<void>;

  constructor(
    ctx: SyncContext,
    restartSubscription: (afterSyncId: SyncId) => Promise<void>
  ) {
    this.ctx = ctx;
    this.restartSubscription = restartSubscription;
  }

  private getActiveOutboxTransactions(): Promise<Transaction[]> {
    return (
      this.ctx.getOutboxManager()?.getActiveTransactions() ??
      Promise.resolve([])
    );
  }

  async handleSyncGroupActions(
    actions: SyncAction[],
    nextSyncId: SyncId
  ): Promise<void> {
    const groupUpdates: string[][] = [];
    for (const action of actions) {
      if (action.action !== "G" && action.action !== "S") {
        continue;
      }
      const data = action.data as Record<string, unknown>;
      const groups = data.subscribedSyncGroups;
      if (Array.isArray(groups)) {
        const filtered = groups.filter(
          (group): group is string => typeof group === "string"
        );
        groupUpdates.push(filtered);
      }
    }

    if (groupUpdates.length === 0) {
      return;
    }

    const nextGroups = groupUpdates.at(-1);
    const currentGroups = this.ctx.getGroups();
    if (!nextGroups || areGroupsEqual(currentGroups, nextGroups)) {
      return;
    }

    const currentSet = new Set(currentGroups);
    const nextSet = new Set(nextGroups);
    const addedGroups = nextGroups.filter((group) => !currentSet.has(group));
    const removedGroups = currentGroups.filter((group) => !nextSet.has(group));

    if (addedGroups.length > 0) {
      await this.bootstrapSyncGroups(
        addedGroups,
        nextSyncId,
        this.ctx.getRunToken()
      );
    }

    if (removedGroups.length > 0) {
      await this.removeSyncGroupData(removedGroups);
    }

    this.ctx.setGroups(nextGroups);
    this.ctx.cursor.setFirstSyncId(nextSyncId);
    await this.ctx.storage.setMeta({
      firstSyncId: this.ctx.cursor.firstSyncId,
      subscribedSyncGroups: this.ctx.getGroups(),
      updatedAt: Date.now(),
    });

    const pending = await this.getActiveOutboxTransactions();
    this.ctx.identityMaps.batch(() => {
      touchPendingTransactionTargets(this.ctx.identityMaps, pending);
      applyPendingTransactionsToIdentityMaps(this.ctx.identityMaps, pending);
    });

    if (this.ctx.isRunning()) {
      await this.restartSubscription(nextSyncId);
    }
  }

  private async bootstrapSyncGroups(
    groups: string[],
    firstSyncId: SyncId,
    runToken: number
  ): Promise<void> {
    const iterator = this.ctx.transport.bootstrap({
      firstSyncId,
      noSyncPackets: true,
      schemaHash: this.ctx.schemaHash,
      syncGroups: groups,
      type: "partial",
    });

    const hydrated = new Set(this.ctx.registry.getEagerHydrationModelNames());

    const cancelIfStale = async (): Promise<boolean> => {
      if (this.ctx.isRunActive(runToken)) {
        return false;
      }

      try {
        await iterator.return?.({ subscribedSyncGroups: groups });
      } catch {
        // Best-effort cleanup when cancellation races with bootstrap.
      }

      return true;
    };

    while (true) {
      if (await cancelIfStale()) {
        return;
      }

      const { value, done } = await iterator.next();
      if (await cancelIfStale()) {
        return;
      }

      if (done) {
        break;
      }

      const row = value;
      const primaryKey = this.ctx.registry.getPrimaryKey(row.modelName);
      const id = row.data[primaryKey] as string;
      if (typeof id !== "string") {
        continue;
      }
      await this.ctx.storage.put(row.modelName, row.data);
      if (await cancelIfStale()) {
        return;
      }

      if (hydrated.has(row.modelName)) {
        const map = this.ctx.identityMaps.getMap(row.modelName);
        map.merge(id, row.data, { serialized: true });
      }
    }
  }

  private async removeSyncGroupData(groups: string[]): Promise<void> {
    if (groups.length === 0) {
      return;
    }

    for (const model of this.ctx.registry.getAllModels()) {
      const modelName = model.name ?? "";
      const { groupKey } = model;
      if (!(modelName && groupKey)) {
        continue;
      }

      const primaryKey = model.primaryKey ?? "id";
      const map =
        this.ctx.identityMaps.getMap<Record<string, unknown>>(modelName);

      for (const group of groups) {
        const rows = await this.ctx.storage.getByIndex<Record<string, unknown>>(
          modelName,
          groupKey,
          group
        );

        for (const row of rows) {
          const id = row[primaryKey] as string;
          if (typeof id !== "string") {
            continue;
          }
          await this.ctx.storage.delete(modelName, id);
          map.delete(id);
          this.ctx.emitEvent?.({
            action: "delete",
            modelId: id,
            modelName,
            type: "modelChange",
          });
        }
      }
    }
  }
}
