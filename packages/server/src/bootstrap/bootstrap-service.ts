import { and, count, eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";

import type {
  BootstrapFilterContext,
  CursorConfig,
  SyncLogger,
  SyncModelConfig,
} from "../config.js";
import { noopLogger } from "../config.js";
import { parseSyncIdString, serializeSyncId } from "../core/sync-id.js";
import type { SyncDao } from "../dao/sync-dao.js";
import type { SyncDb } from "../db.js";
import type { BootstrapRequest, SyncUserContext } from "../types.js";
import { resolveRequestedSyncGroups } from "../utils/sync-scope.js";
import { getColumn } from "../utils/sync-utils.js";
import { streamModel } from "./cursor.js";
import type { BootstrapFieldDef } from "./row-mapper.js";
import { mapRow, normalizeModelId, serializeBatchRow } from "./row-mapper.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface BootstrapModelDef {
  table: AnyPgTable;
  fieldDef: BootstrapFieldDef;
  cursor: CursorConfig;
  buildScopeWhere: (
    filter: BootstrapFilterContext,
    db: unknown
  ) => SQL<unknown>;
  allowedIndexedKeys?: readonly string[];
}

// oxlint-disable-next-line func-style, require-yields -- intentionally empty stream
async function* EMPTY_ROW_STREAM(): AsyncGenerator<
  Record<string, unknown>,
  void,
  unknown
> {
  // No rows for an unknown model.
}

interface BatchLoadRequestIndexed {
  modelName: string;
  indexedKey: string;
  keyValue: string;
}

interface BatchLoadRequestGroup {
  modelName: string;
  groupId: string;
}

type BatchLoadRequest = BatchLoadRequestIndexed | BatchLoadRequestGroup;

const isIndexedRequest = (
  request: BatchLoadRequest
): request is BatchLoadRequestIndexed =>
  "indexedKey" in request && "keyValue" in request;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const combineWhere = (
  conditions: (SQL<unknown> | undefined)[]
): SQL<unknown> | undefined => {
  const active = conditions.filter(
    (condition): condition is SQL<unknown> => condition !== undefined
  );

  if (active.length === 0) {
    return undefined;
  }

  const [first, ...rest] = active;
  if (!first) {
    return undefined;
  }

  if (rest.length === 0) {
    return first;
  }

  return and(first, ...rest);
};

const scopedWhere = (
  scope: SQL<unknown>,
  ...conditions: (SQL<unknown> | undefined)[]
): SQL<unknown> => combineWhere([scope, ...conditions]) ?? scope;

const toCountNumber = (value: unknown): number => {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class BootstrapService {
  private readonly dao: SyncDao;
  private readonly db: SyncDb;
  private readonly modelRegistry: Record<string, BootstrapModelDef>;
  private readonly allowedIndexedKeys: Record<string, readonly string[]>;
  private readonly allModelNames: string[];
  private readonly logger: SyncLogger;

  constructor(
    db: unknown,
    dao: SyncDao,
    models: Record<string, SyncModelConfig>,
    logger: SyncLogger = noopLogger
  ) {
    this.db = db as SyncDb;
    this.dao = dao;
    this.logger = logger;

    // Build internal registries from config
    this.modelRegistry = {};
    this.allowedIndexedKeys = {};

    for (const [name, model] of Object.entries(models)) {
      this.modelRegistry[name] = {
        buildScopeWhere: model.bootstrap.buildScopeWhere,
        cursor: model.bootstrap.cursor,
        fieldDef: {
          dateOnlyFields: model.bootstrap.dateOnlyFields,
          fields: model.bootstrap.fields,
          instantFields: model.bootstrap.instantFields,
        },
        table: model.table,
      };

      if (model.bootstrap.allowedIndexedKeys) {
        this.allowedIndexedKeys[name] = model.bootstrap.allowedIndexedKeys;
      }
    }

    this.allModelNames = Object.keys(this.modelRegistry);
  }

  async *generateBootstrapNdjson(
    context: SyncUserContext,
    request: BootstrapRequest
  ): AsyncGenerator<string, void, unknown> {
    const groups = resolveRequestedSyncGroups(context.groups, request.groups);

    this.logger.info({ groups, userId: context.userId }, "Bootstrap started");

    const filter = BootstrapService.buildFilterContext({
      ...context,
      groups,
    });
    const snapshotLastSyncId = await this.dao.getLastSyncIdForGroups(groups);
    const filterAfterSyncId =
      request.type === "partial" && request.firstSyncId
        ? parseSyncIdString(request.firstSyncId)
        : snapshotLastSyncId;

    const modelsToBootstrap = request.models ?? this.allModelNames;
    const returnedModelsCount: Record<string, number> = {};

    // Rows in scope at the snapshot (pre touched-filter). Informational metadata
    // only — no first-party consumer relies on it matching the streamed count.
    for (const modelName of modelsToBootstrap) {
      const modelCount = await this.countModelRows(modelName, filter);
      returnedModelsCount[modelName] = modelCount;
    }

    const metadata = {
      lastSyncId: serializeSyncId(snapshotLastSyncId),
      returnedModelsCount,
      schemaHash: request.schemaHash,
      subscribedSyncGroups: groups,
    };

    this.logger.debug({ metadata }, "Bootstrap metadata");
    yield JSON.stringify(metadata);

    for (const modelName of modelsToBootstrap) {
      let rowCount = 0;
      for await (const line of this.streamFilteredModelRows(
        modelName,
        filter,
        groups,
        filterAfterSyncId
      )) {
        rowCount += 1;
        yield line;
      }
      this.logger.debug({ modelName, rowCount }, "Bootstrap model streamed");
    }

    this.logger.info(
      { groups, returnedModelsCount, userId: context.userId },
      "Bootstrap completed"
    );
  }

  async *batchLoadNdjson(
    context: SyncUserContext,
    requests: BatchLoadRequest[],
    firstSyncId?: string
  ): AsyncGenerator<string, void, unknown> {
    await Promise.resolve();
    const batchFirstSyncId = firstSyncId
      ? parseSyncIdString(firstSyncId)
      : undefined;

    for (const request of requests) {
      let requestGroups = context.groups;
      if (!isIndexedRequest(request)) {
        requestGroups = resolveRequestedSyncGroups(context.groups, [
          request.groupId,
        ]);
      }
      if (!isIndexedRequest(request) && requestGroups.length === 0) {
        continue;
      }
      const filter = BootstrapService.buildFilterContext({
        ...context,
        groups: requestGroups,
      });
      yield* this.batchLoadModel(
        request.modelName,
        request,
        filter,
        requestGroups,
        batchFirstSyncId
      );
    }
  }

  private static buildFilterContext(
    context: SyncUserContext
  ): BootstrapFilterContext {
    const groupIds = [...new Set(context.groups)];
    return {
      authorizedGroupIds: groupIds,
      userId: context.userId,
      workspaceGroupIds: groupIds.filter((group) => group !== context.userId),
    };
  }

  private static buildIndexedWhere(
    modelName: string,
    request: BatchLoadRequest,
    allowedIndexedKeys: Record<string, readonly string[]>
  ): Record<string, string> | undefined {
    if (!isIndexedRequest(request)) {
      return undefined;
    }

    const allowed = allowedIndexedKeys[modelName];
    if (!allowed?.includes(request.indexedKey)) {
      throw new Error(
        `Indexed key "${request.indexedKey}" is not allowed for model "${modelName}"`
      );
    }

    return { [request.indexedKey]: request.keyValue };
  }

  private static indexedWhereCondition(
    table: AnyPgTable,
    indexedWhere: Record<string, string> | undefined
  ): SQL<unknown> | undefined {
    if (!indexedWhere) {
      return undefined;
    }

    const conditions = Object.entries(indexedWhere).map(([key, value]) =>
      eq(getColumn(table, key), value)
    );

    return combineWhere(conditions);
  }

  // -------------------------------------------------------------------------
  // Generic batch loading
  // -------------------------------------------------------------------------

  private async *batchLoadModel(
    modelName: string,
    request: BatchLoadRequest,
    filter: BootstrapFilterContext,
    groups: string[],
    firstSyncId?: bigint
  ): AsyncGenerator<string, void, unknown> {
    const def = this.modelRegistry[modelName];
    if (!def) {
      return;
    }

    const indexedWhere = BootstrapService.buildIndexedWhere(
      modelName,
      request,
      this.allowedIndexedKeys
    );
    const indexedCondition = BootstrapService.indexedWhereCondition(
      def.table,
      indexedWhere
    );
    const scopeWhereVal = def.buildScopeWhere(filter, this.db);
    const where = scopedWhere(scopeWhereVal, indexedCondition);

    if (!indexedWhere) {
      yield* this.streamFilteredModelRows(
        modelName,
        filter,
        groups,
        firstSyncId
      );
      return;
    }

    const MAX_INDEXED_ROWS = 50_000;
    const rows = (await this.db
      .select()
      .from(def.table)
      .where(where)
      .orderBy()
      .limit(MAX_INDEXED_ROWS + 1)) as Record<string, unknown>[];

    if (rows.length > MAX_INDEXED_ROWS) {
      throw new Error(
        `Indexed batch load exceeded ${MAX_INDEXED_ROWS} rows for model "${modelName}"`
      );
    }

    const mappedRows = rows.map((row) => mapRow(row, def.fieldDef, def.cursor));
    yield* this.filterBatchRowsByFirstSyncId(
      modelName,
      mappedRows,
      groups,
      firstSyncId
    );
  }

  private async *filterBatchRowsByFirstSyncId(
    modelName: string,
    rows: Record<string, unknown>[],
    groups: string[],
    firstSyncId?: bigint
  ): AsyncGenerator<string, void, unknown> {
    if (!(firstSyncId && rows.length > 0)) {
      for (const row of rows) {
        yield serializeBatchRow(modelName, row);
      }
      return;
    }

    const modelIds = rows
      .map((row) => normalizeModelId(row.id))
      .filter((id): id is string => id !== null);

    const touchedIds = await this.dao.getTouchedModelIdsAfter(
      firstSyncId,
      groups,
      modelName,
      modelIds
    );

    for (const row of rows) {
      const rowId = normalizeModelId(row.id);
      if (rowId && touchedIds.has(rowId)) {
        continue;
      }

      yield serializeBatchRow(modelName, row);
    }
  }

  private async *streamFilteredModelRows(
    modelName: string,
    filter: BootstrapFilterContext,
    groups: string[],
    firstSyncId?: bigint
  ): AsyncGenerator<string, void, unknown> {
    let bufferedRows: Record<string, unknown>[] = [];
    for await (const row of this.streamModelRows(modelName, filter)) {
      bufferedRows.push(row);
      if (bufferedRows.length < 250) {
        continue;
      }

      yield* this.filterBatchRowsByFirstSyncId(
        modelName,
        bufferedRows,
        groups,
        firstSyncId
      );
      bufferedRows = [];
    }

    if (bufferedRows.length > 0) {
      yield* this.filterBatchRowsByFirstSyncId(
        modelName,
        bufferedRows,
        groups,
        firstSyncId
      );
    }
  }

  // -------------------------------------------------------------------------
  // Count / stream helpers
  // -------------------------------------------------------------------------

  private async countModelRows(
    modelName: string,
    filter: BootstrapFilterContext
  ): Promise<number> {
    const def = this.modelRegistry[modelName];
    if (!def) {
      return 0;
    }

    const scopeWhereVal = def.buildScopeWhere(filter, this.db);
    const [result] = await this.db
      .select({ count: count() })
      .from(def.table)
      .where(scopeWhereVal)
      .orderBy()
      .limit(1);

    return toCountNumber(result?.count);
  }

  private streamModelRows(
    modelName: string,
    filter: BootstrapFilterContext
  ): AsyncGenerator<Record<string, unknown>, void, unknown> {
    const def = this.modelRegistry[modelName];
    if (!def) {
      return EMPTY_ROW_STREAM();
    }

    return streamModel(
      this.db,
      def.table,
      def.buildScopeWhere(filter, this.db),
      def.fieldDef,
      def.cursor
    );
  }
}
