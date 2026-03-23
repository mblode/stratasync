import { and, asc, count, eq, gt, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";

import type {
  BootstrapFilterContext,
  CursorConfig,
  SyncLogger,
  SyncModelConfig,
} from "../config.js";
import { noopLogger } from "../config.js";
import type { SyncDao } from "../dao/sync-dao.js";
import type { SyncDb } from "../db.js";
import type { BootstrapRequest, SyncUserContext } from "../types.js";
import { toDateOnlyEpoch, toInstantEpoch } from "../utils/dates.js";
import { resolveRequestedSyncGroups } from "../utils/sync-scope.js";
import {
  getColumn,
  parseSyncIdString,
  serializeSyncId,
} from "../utils/sync-utils.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface BootstrapModelDef {
  table: AnyPgTable;
  fieldDef: {
    fields: readonly string[];
    dateOnlyFields?: readonly string[];
    instantFields?: readonly string[];
  };
  cursor: CursorConfig;
  buildScopeWhere: (
    filter: BootstrapFilterContext,
    db: unknown
  ) => SQL<unknown>;
  allowedIndexedKeys?: readonly string[];
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

const isCursorValue = (value: unknown): boolean =>
  value !== undefined && value !== null;

const normalizeModelId = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  return null;
};

const mapRow = (
  item: Record<string, unknown>,
  def: BootstrapModelDef
): Record<string, unknown> => {
  const dateOnlySet = new Set(def.fieldDef.dateOnlyFields);
  const instantSet = new Set(def.fieldDef.instantFields);
  const row: Record<string, unknown> = {};

  for (const field of def.fieldDef.fields) {
    if (dateOnlySet.has(field)) {
      row[field] = toDateOnlyEpoch(item[field]);
      continue;
    }

    if (instantSet.has(field)) {
      row[field] = toInstantEpoch(item[field]);
      continue;
    }

    row[field] = item[field];
  }

  row.id =
    def.cursor.type === "simple"
      ? item[def.cursor.idField]
      : def.cursor.syntheticId(item);

  return row;
};

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
    const lastSyncId = await this.dao.getLastSyncIdForGroups(groups);

    const modelsToBootstrap = request.models ?? this.allModelNames;
    const returnedModelsCount: Record<string, number> = {};

    for (const modelName of modelsToBootstrap) {
      const modelCount = await this.countBootstrapModelRows(
        modelName,
        filter,
        groups,
        lastSyncId
      );
      returnedModelsCount[modelName] = modelCount;
    }

    const metadata = {
      lastSyncId: serializeSyncId(lastSyncId),
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
        lastSyncId
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

  private static simpleCursorCondition(
    table: AnyPgTable,
    idField: string,
    cursor: unknown
  ): SQL<unknown> | undefined {
    if (!isCursorValue(cursor)) {
      return undefined;
    }

    return gt(getColumn(table, idField), cursor);
  }

  private static compositeCursorCondition(
    table: AnyPgTable,
    fields: readonly string[],
    cursorValues: Record<string, unknown> | undefined
  ): SQL<unknown> | undefined {
    if (!cursorValues || fields.length === 0) {
      return undefined;
    }

    const orConditions: SQL<unknown>[] = [];

    for (let index = 0; index < fields.length; index += 1) {
      const branch = BootstrapService.compositeCursorBranch(
        table,
        fields,
        cursorValues,
        index
      );
      if (branch) {
        orConditions.push(branch);
      }
    }

    if (orConditions.length === 0) {
      return undefined;
    }

    const [first, ...rest] = orConditions;
    if (!first) {
      return undefined;
    }

    if (rest.length === 0) {
      return first;
    }

    return or(first, ...rest) as SQL<unknown>;
  }

  private static compositeCursorBranch(
    table: AnyPgTable,
    fields: readonly string[],
    cursorValues: Record<string, unknown>,
    index: number
  ): SQL<unknown> | undefined {
    const field = fields[index];
    if (!field) {
      return undefined;
    }

    const fieldValue = cursorValues[field];
    if (!isCursorValue(fieldValue)) {
      return undefined;
    }

    const currentGreaterThan = gt(getColumn(table, field), fieldValue);
    if (index === 0) {
      return currentGreaterThan;
    }

    const prefix = BootstrapService.compositeCursorPrefix(
      table,
      fields,
      cursorValues,
      index
    );
    return prefix
      ? (and(prefix, currentGreaterThan) as SQL<unknown>)
      : currentGreaterThan;
  }

  private static compositeCursorPrefix(
    table: AnyPgTable,
    fields: readonly string[],
    cursorValues: Record<string, unknown>,
    index: number
  ): SQL<unknown> | undefined {
    const prefixConditions: SQL<unknown>[] = [];

    for (let prefixIndex = 0; prefixIndex < index; prefixIndex += 1) {
      const prefixField = fields[prefixIndex];
      if (!prefixField) {
        continue;
      }

      const prefixValue = cursorValues[prefixField];
      if (!isCursorValue(prefixValue)) {
        continue;
      }

      prefixConditions.push(eq(getColumn(table, prefixField), prefixValue));
    }

    return combineWhere(prefixConditions);
  }

  // -------------------------------------------------------------------------
  // Generic streaming (cursor-based pagination)
  // -------------------------------------------------------------------------

  private async *streamModel(
    modelName: string,
    batchSize: number,
    filter: BootstrapFilterContext
  ): AsyncGenerator<Record<string, unknown>, void, unknown> {
    const def = this.modelRegistry[modelName];
    if (!def) {
      return;
    }

    await Promise.resolve();

    // oxlint-disable-next-line prefer-ternary -- yield* cannot appear inside a ternary expression
    if (def.cursor.type === "simple") {
      yield* this.streamSimpleCursor(def, batchSize, filter);
    } else {
      yield* this.streamCompositeCursor(def, batchSize, filter);
    }
  }

  private async *streamSimpleCursor(
    def: BootstrapModelDef,
    batchSize: number,
    filter: BootstrapFilterContext
  ): AsyncGenerator<Record<string, unknown>, void, unknown> {
    if (def.cursor.type !== "simple") {
      return;
    }

    const scopeWhere = def.buildScopeWhere(filter, this.db);
    const idColumn = getColumn(def.table, def.cursor.idField);
    let cursor: unknown;

    while (true) {
      const cursorWhere = BootstrapService.simpleCursorCondition(
        def.table,
        def.cursor.idField,
        cursor
      );
      const where = scopedWhere(scopeWhere, cursorWhere);

      const rows = (await this.db
        .select()
        .from(def.table)
        .where(where)
        .orderBy(asc(idColumn))
        .limit(batchSize)) as Record<string, unknown>[];

      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        yield mapRow(row, def);
      }

      const last = rows.at(-1);
      const nextCursor = last?.[def.cursor.idField];
      if (rows.length === batchSize && isCursorValue(nextCursor)) {
        cursor = nextCursor;
      } else {
        break;
      }
    }
  }

  private async *streamCompositeCursor(
    def: BootstrapModelDef,
    batchSize: number,
    filter: BootstrapFilterContext
  ): AsyncGenerator<Record<string, unknown>, void, unknown> {
    if (def.cursor.type !== "composite") {
      return;
    }

    const scopeWhere = def.buildScopeWhere(filter, this.db);
    const orderByColumns = def.cursor.fields.map((field) =>
      asc(getColumn(def.table, field))
    );

    const [firstOrder, ...restOrder] = orderByColumns;
    if (!firstOrder) {
      return;
    }

    let cursorValues: Record<string, unknown> | undefined;

    while (true) {
      const cursorWhere = BootstrapService.compositeCursorCondition(
        def.table,
        def.cursor.fields,
        cursorValues
      );
      const where = scopedWhere(scopeWhere, cursorWhere);

      const rows = (await this.db
        .select()
        .from(def.table)
        .where(where)
        .orderBy(firstOrder, ...restOrder)
        .limit(batchSize)) as Record<string, unknown>[];

      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        yield mapRow(row, def);
      }

      const last = rows.at(-1);
      if (!(last && rows.length === batchSize)) {
        break;
      }

      const nextCursor: Record<string, unknown> = {};
      let validCursor = true;
      for (const field of def.cursor.fields) {
        const value = last[field];
        if (!isCursorValue(value)) {
          validCursor = false;
          break;
        }
        nextCursor[field] = value;
      }

      if (!validCursor) {
        break;
      }

      cursorValues = nextCursor;
    }
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

    const mappedRows = rows.map((row) => mapRow(row, def));
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
        yield BootstrapService.serializeBatchRow(modelName, row);
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

      yield BootstrapService.serializeBatchRow(modelName, row);
    }
  }

  private static serializeBatchRow(
    modelName: string,
    row: Record<string, unknown>
  ): string {
    return JSON.stringify({
      __class: modelName,
      ...row,
    });
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

  private async countBootstrapModelRows(
    modelName: string,
    filter: BootstrapFilterContext,
    groups: string[],
    firstSyncId: bigint
  ): Promise<number> {
    if (firstSyncId === 0n) {
      return await this.countModelRows(modelName, filter);
    }

    let rowCount = 0;
    for await (const _line of this.streamFilteredModelRows(
      modelName,
      filter,
      groups,
      firstSyncId
    )) {
      rowCount += 1;
    }

    return rowCount;
  }

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
    return this.streamModel(modelName, 1000, filter);
  }
}
