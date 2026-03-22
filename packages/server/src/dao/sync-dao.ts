import { and, asc, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";

import type { SyncDb } from "../db.js";
import { getColumn } from "../utils/sync-utils.js";

export interface SyncDaoTables {
  syncActions: AnyPgTable;
  syncGroupMemberships: AnyPgTable;
}

export interface SyncActionInsert {
  model: string;
  modelId: string;
  action: string;
  data: Record<string, unknown>;
  groupId: string | null;
  clientTxId: string | null;
  clientId: string | null;
}

interface SyncActionRow {
  id: bigint;
  model: string;
  modelId: string;
  action: string;
  data: unknown;
  groupId: string | null;
  clientTxId: string | null;
  clientId: string | null;
  createdAt: Date;
}

const ensureBigint = (value: bigint | string): bigint => {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "string") {
    return BigInt(value);
  }
  throw new Error(
    `Expected sync ID as bigint or string, received ${typeof value}`
  );
};

/**
 * Data access object for sync operations.
 * Accepts Drizzle table references instead of hardcoded schema imports.
 */
export class SyncDao {
  private readonly db: SyncDb;
  private readonly tables: SyncDaoTables;

  constructor(db: unknown, tables: SyncDaoTables) {
    this.db = db as SyncDb;
    this.tables = tables;
  }

  private visibleGroupCondition(groups: string[]) {
    const groupIdCol = getColumn(this.tables.syncActions, "groupId");
    if (groups.length === 0) {
      return isNull(groupIdCol);
    }
    return or(isNull(groupIdCol), inArray(groupIdCol, groups));
  }

  /**
   * Gets the last sync ID.
   */
  async getLastSyncId(): Promise<bigint> {
    const idCol = getColumn(this.tables.syncActions, "id");
    const rows = await this.db
      .select({ id: idCol })
      .from(this.tables.syncActions)
      .where()
      .orderBy(desc(idCol))
      .limit(1);

    const [result] = rows;
    return result ? ensureBigint(result.id as bigint | string) : 0n;
  }

  /**
   * Gets the last sync ID visible to the given groups.
   */
  async getLastSyncIdForGroups(groups: string[]): Promise<bigint> {
    const idCol = getColumn(this.tables.syncActions, "id");
    const rows = await this.db
      .select({ id: idCol })
      .from(this.tables.syncActions)
      .where(this.visibleGroupCondition(groups))
      .orderBy(desc(idCol))
      .limit(1);

    const [result] = rows;
    return result ? ensureBigint(result.id as bigint | string) : 0n;
  }

  /**
   * Gets sync actions after a given ID.
   */
  async getSyncActions(
    afterId: bigint,
    groups: string[],
    limit: number
  ): Promise<SyncActionRow[]> {
    const idCol = getColumn(this.tables.syncActions, "id");
    const rows = await this.db
      .select()
      .from(this.tables.syncActions)
      .where(and(gt(idCol, afterId), this.visibleGroupCondition(groups)))
      .orderBy(asc(idCol))
      .limit(limit);

    return rows as unknown as SyncActionRow[];
  }

  async getTouchedModelIdsAfter(
    afterId: bigint,
    groups: string[],
    modelName: string,
    modelIds: string[]
  ): Promise<Set<string>> {
    if (modelIds.length === 0) {
      return new Set();
    }

    const idCol = getColumn(this.tables.syncActions, "id");
    const modelCol = getColumn(this.tables.syncActions, "model");
    const modelIdCol = getColumn(this.tables.syncActions, "modelId");

    const rows = await this.db
      .select({ modelId: modelIdCol })
      .from(this.tables.syncActions)
      .where(
        and(
          gt(idCol, afterId),
          this.visibleGroupCondition(groups),
          eq(modelCol, modelName),
          inArray(modelIdCol, modelIds)
        )
      )
      .limit(50_000);

    return new Set(
      rows.map((row: Record<string, unknown>) => row.modelId as string)
    );
  }

  /**
   * Creates a sync action.
   */
  async createSyncAction(data: SyncActionInsert): Promise<SyncActionRow> {
    const rows = await this.db
      .insert(this.tables.syncActions)
      .values({
        action: data.action,
        clientId: data.clientId,
        clientTxId: data.clientTxId,
        data: data.data,
        groupId: data.groupId,
        model: data.model,
        modelId: data.modelId,
      })
      .returning();

    const [created] = rows;
    if (!created) {
      throw new Error("Failed to create sync action");
    }

    return created as unknown as SyncActionRow;
  }

  /**
   * Gets user's group memberships.
   */
  async getUserGroups(userId: string): Promise<string[]> {
    const userIdCol = getColumn(this.tables.syncGroupMemberships, "userId");
    const groupIdCol = getColumn(this.tables.syncGroupMemberships, "groupId");

    const rows = await this.db
      .select({ groupId: groupIdCol })
      .from(this.tables.syncGroupMemberships)
      .where(eq(userIdCol, userId))
      .limit(10_000);

    return rows.map(
      (membership: Record<string, unknown>) => membership.groupId as string
    );
  }

  /**
   * Finds an existing sync action for a client transaction.
   */
  async findSyncActionByClientTx(
    clientId: string,
    clientTxId: string
  ): Promise<{ id: bigint } | null> {
    const idCol = getColumn(this.tables.syncActions, "id");
    const clientIdCol = getColumn(this.tables.syncActions, "clientId");
    const clientTxIdCol = getColumn(this.tables.syncActions, "clientTxId");

    const rows = await this.db
      .select({ id: idCol })
      .from(this.tables.syncActions)
      .where(and(eq(clientIdCol, clientId), eq(clientTxIdCol, clientTxId)))
      .orderBy(asc(idCol))
      .limit(1);

    const [result] = rows;
    return result ? { id: ensureBigint(result.id as bigint | string) } : null;
  }
}
