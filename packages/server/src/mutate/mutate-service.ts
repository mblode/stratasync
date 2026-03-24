import { eq, getTableColumns } from "drizzle-orm";

import type { SyncLogger, SyncModelConfig } from "../config.js";
import { noopLogger } from "../config.js";
import type { SyncDao } from "../dao/sync-dao.js";
import type { SyncDb } from "../db.js";
import type {
  MutateInput,
  MutateResult,
  ModelAction,
  SyncActionOutput,
  SyncUserContext,
  TransactionInput,
  TransactionResult,
} from "../types.js";
import { mapGraphQLAction } from "../types.js";
import { serializeSyncId, toSyncActionOutput } from "../utils/sync-utils.js";
import {
  createModelHandler,
  createStandardDelegate,
  createCompositeDelegate,
} from "./model-handlers.js";
import type { ModelDef, MutationDelegate } from "./model-handlers.js";

const MODEL_ID_GROUP_KEY = "__modelId__";

const SYNC_ACTION_DEDUP_CONSTRAINT =
  "sync_actions_client_id_client_tx_id_unique";

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

const isSyncDedupUniqueConstraintError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const maybeError = error as {
    code?: unknown;
    constraint?: unknown;
  };

  return (
    maybeError.code === "23505" &&
    maybeError.constraint === SYNC_ACTION_DEDUP_CONSTRAINT
  );
};

const formatWarningMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface ProcessedTransactionSuccess {
  success: true;
  result: TransactionResult;
  syncId: bigint;
}

interface ProcessedTransactionFailure {
  success: false;
  result: TransactionResult;
}

type ProcessedTransactionResult =
  | ProcessedTransactionSuccess
  | ProcessedTransactionFailure;

interface TransactionWorkResult {
  data: Record<string, unknown>;
  syncAction: SyncActionRow;
}

type ProcessAction = ReturnType<typeof mapGraphQLAction>;

interface PreparedTransaction {
  action: ProcessAction;
  canonicalModelId: string;
  modelConfig: SyncModelConfig | null;
}

// ---------------------------------------------------------------------------
// Model lookup (for resolving groupId from DB)
// ---------------------------------------------------------------------------

type ModelLookup = (
  db: unknown,
  id: string
) => Promise<Record<string, unknown> | null>;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class MutateService {
  private readonly dao: SyncDao;
  private readonly db: SyncDb;
  private readonly logger: SyncLogger;
  private readonly modelHandlers: Map<
    string,
    (
      db: unknown,
      modelId: string,
      payload: Record<string, unknown>,
      action: ModelAction,
      context?: SyncUserContext
    ) => Promise<Record<string, unknown>>
  >;
  private readonly modelGroupKeys: Record<string, string>;
  private readonly modelDelegates: Record<string, ModelLookup>;
  private readonly modelConfigs: Record<string, SyncModelConfig>;

  constructor(
    db: unknown,
    dao: SyncDao,
    models: Record<string, SyncModelConfig>,
    logger: SyncLogger = noopLogger
  ) {
    this.db = db as SyncDb;
    this.dao = dao;
    this.logger = logger;
    this.modelConfigs = models;

    // Build handlers, group keys, and delegates from config
    this.modelHandlers = new Map();
    this.modelGroupKeys = {};
    this.modelDelegates = {};

    for (const [name, model] of Object.entries(models)) {
      // Group key
      if (model.groupKey !== null) {
        this.modelGroupKeys[name] = model.groupKey;
      }

      // Delegate for lookups
      if (model.mutate.kind === "standard") {
        const idField = model.mutate.idField ?? "id";
        let idColumn: unknown;
        try {
          const cols = getTableColumns(model.table) as Record<string, unknown>;
          idColumn = cols[idField];
        } catch {
          // Table columns unavailable, skip delegate registration
        }

        if (idColumn) {
          this.modelDelegates[name] = async (lookupDb, id) => {
            const typedDb = lookupDb as SyncDb;
            const rows = await typedDb
              .select()
              .from(model.table)
              .where(eq(idColumn as never, id))
              .limit(1);
            return (rows[0] as Record<string, unknown> | undefined) ?? null;
          };
        }
      }

      // Model handler
      const mutateConfig = model.mutate;
      const delegate: MutationDelegate =
        mutateConfig.kind === "standard"
          ? createStandardDelegate(model.table, mutateConfig.idField ?? "id")
          : createCompositeDelegate(model.table, mutateConfig.buildDeleteWhere);

      const def: ModelDef =
        mutateConfig.kind === "standard"
          ? {
              actions: mutateConfig.actions,
              delegate,
              insertFields: mutateConfig.insertFields,
              kind: "standard",
              onBeforeInsert: mutateConfig.onBeforeInsert,
              onBeforeUpdate: mutateConfig.onBeforeUpdate,
              onBeforeDelete: mutateConfig.onBeforeDelete,
              updateFields: mutateConfig.updateFields,
            }
          : {
              actions: mutateConfig.actions,
              delegate,
              insertFields: mutateConfig.insertFields,
              kind: "composite",
            };

      this.modelHandlers.set(name, createModelHandler(def));
    }
  }

  /**
   * Resolve the groupId for a sync action.
   */
  private async lookupModelRecord(
    db: SyncDb,
    modelName: string,
    modelId: string
  ): Promise<Record<string, unknown> | null> {
    const lookup = this.modelDelegates[modelName];
    if (!lookup) {
      return null;
    }

    return await lookup(db, modelId);
  }

  private async resolveGroupId(
    db: SyncDb,
    modelName: string,
    modelId: string,
    action: string,
    payload: Record<string, unknown>
  ): Promise<string | null> {
    const groupKey = this.modelGroupKeys[modelName];
    if (!groupKey) {
      return null;
    }

    if (groupKey === MODEL_ID_GROUP_KEY) {
      return modelId;
    }

    if (action === "I") {
      const payloadValue = payload[groupKey];
      if (typeof payloadValue === "string" && payloadValue.length > 0) {
        return payloadValue;
      }

      this.logger.warn(
        { groupKey, modelName },
        "Missing group key in insert payload"
      );
      throw new Error("Invalid mutation: missing required group identifier");
    }

    const record = await this.lookupModelRecord(db, modelName, modelId);
    if (record) {
      return (record[groupKey] as string | null | undefined) ?? null;
    }

    const payloadValue = payload[groupKey];
    if (typeof payloadValue === "string" && payloadValue.length > 0) {
      return payloadValue;
    }

    this.logger.warn(
      { groupKey, modelId, modelName },
      "Cannot resolve group for mutation"
    );
    throw new Error("Invalid mutation: record not found");
  }

  private static validateGroupAccess(
    context: SyncUserContext,
    groupId: string | null,
    modelName: string,
    logger: SyncLogger
  ): void {
    if (groupId !== null && !context.groups.includes(groupId)) {
      logger.warn(
        { groupId, modelName, userId: context.userId },
        "Access denied for mutation"
      );
      throw new Error("Access denied");
    }
  }

  private static createDuplicateTransactionResult(
    tx: TransactionInput,
    syncId: bigint,
    logger: SyncLogger
  ): ProcessedTransactionSuccess {
    logger.debug(
      {
        clientTxId: tx.clientTxId,
        syncId: serializeSyncId(syncId),
      },
      "Duplicate transaction skipped"
    );

    return {
      result: MutateService.createSuccessResult(tx, syncId),
      success: true,
      syncId,
    };
  }

  private prepareTransaction(tx: TransactionInput): PreparedTransaction {
    const action = mapGraphQLAction(tx.action);

    // Resolve canonical model ID for composite models
    const modelConfig = this.modelConfigs[tx.modelName];
    let canonicalModelId = tx.modelId;

    if (
      modelConfig?.mutate.kind === "composite" &&
      modelConfig.mutate.compositeId
    ) {
      canonicalModelId = modelConfig.mutate.compositeId.computeId(
        tx.modelName,
        tx.modelId,
        tx.payload
      );
    }

    return {
      action,
      canonicalModelId,
      modelConfig: modelConfig ?? null,
    };
  }

  private async ensureMutationTargetExists(
    db: SyncDb,
    tx: TransactionInput,
    prepared: PreparedTransaction
  ): Promise<void> {
    if (prepared.action === "I") {
      return;
    }

    if (prepared.modelConfig?.mutate.kind !== "standard") {
      return;
    }

    const row = await this.lookupModelRecord(
      db,
      tx.modelName,
      prepared.canonicalModelId
    );
    if (!row) {
      throw new Error("Invalid mutation: record not found");
    }
  }

  private async applyModelMutation(
    db: SyncDb,
    tx: TransactionInput,
    prepared: PreparedTransaction,
    context?: SyncUserContext
  ): Promise<Record<string, unknown>> {
    const handler = this.modelHandlers.get(tx.modelName);

    if (!handler) {
      throw new Error(`Unknown model: ${tx.modelName}`);
    }

    return await handler(
      db,
      prepared.canonicalModelId,
      tx.payload,
      prepared.action,
      context
    );
  }

  private async resolveAuthorizedGroupId(
    db: SyncDb,
    context: SyncUserContext,
    tx: TransactionInput,
    prepared: PreparedTransaction
  ): Promise<string | null> {
    const groupId = await this.resolveGroupId(
      db,
      tx.modelName,
      prepared.canonicalModelId,
      prepared.action,
      tx.payload
    );

    MutateService.validateGroupAccess(
      context,
      groupId,
      tx.modelName,
      this.logger
    );

    return groupId;
  }

  private static publishSyncAction(
    syncAction: SyncActionRow,
    onAction?: (action: SyncActionOutput) => void
  ): void {
    if (!onAction) {
      return;
    }

    onAction(toSyncActionOutput(syncAction));
  }

  static validateTransaction(tx: TransactionInput): string[] {
    const errors: string[] = [];

    if (!tx.clientTxId) {
      errors.push("clientTxId is required");
    }
    if (!tx.clientId) {
      errors.push("clientId is required");
    }
    if (!tx.modelName) {
      errors.push("modelName is required");
    }
    if (!tx.modelId) {
      errors.push("modelId is required");
    }
    if (!tx.action) {
      errors.push("action is required");
    }
    if (
      !["INSERT", "UPDATE", "DELETE", "ARCHIVE", "UNARCHIVE"].includes(
        tx.action
      )
    ) {
      errors.push(`Invalid action: ${tx.action}`);
    }

    return errors;
  }

  private static createSuccessResult(
    tx: TransactionInput,
    syncId: bigint,
    warnings?: string[]
  ): TransactionResult {
    const result: TransactionResult = {
      clientTxId: tx.clientTxId,
      success: true,
      syncId: serializeSyncId(syncId),
    };

    if (warnings && warnings.length > 0) {
      result.warnings = warnings;
    }

    return result;
  }

  private static async createSyncActionInTransaction(
    dao: SyncDao,
    tx: TransactionInput,
    action: string,
    canonicalModelId: string,
    data: Record<string, unknown>,
    groupId: string | null
  ): Promise<SyncActionRow> {
    return (await dao.createSyncAction({
      action,
      clientId: tx.clientId,
      clientTxId: tx.clientTxId,
      data,
      groupId,
      model: tx.modelName,
      modelId: canonicalModelId,
    })) as unknown as SyncActionRow;
  }

  private async processTransaction(
    context: SyncUserContext,
    tx: TransactionInput,
    onAction?: (action: SyncActionOutput) => void
  ): Promise<ProcessedTransactionResult> {
    try {
      const existing = await this.dao.findSyncActionByClientTx(
        tx.clientId,
        tx.clientTxId
      );
      if (existing) {
        return MutateService.createDuplicateTransactionResult(
          tx,
          existing.id,
          this.logger
        );
      }

      const workResult = await this.db.transaction(async (txDb) => {
        const txDao = this.dao.withDb(txDb);
        const prepared = this.prepareTransaction(tx);
        await this.ensureMutationTargetExists(txDb, tx, prepared);
        const groupId = await this.resolveAuthorizedGroupId(
          txDb,
          context,
          tx,
          prepared
        );
        const data = await this.applyModelMutation(txDb, tx, prepared, context);
        const syncAction = await MutateService.createSyncActionInTransaction(
          txDao,
          tx,
          prepared.action,
          prepared.canonicalModelId,
          data,
          groupId
        );

        return {
          data,
          syncAction,
        } satisfies TransactionWorkResult;
      });

      this.logger.debug(
        {
          action: workResult.syncAction.action,
          modelId: workResult.syncAction.modelId,
          modelName: tx.modelName,
          syncId: serializeSyncId(workResult.syncAction.id),
        },
        "Transaction processed"
      );

      const warnings: string[] = [];
      const modelConfig = this.modelConfigs[tx.modelName];
      if (modelConfig?.mutate.onAfterMutation) {
        try {
          await modelConfig.mutate.onAfterMutation({
            action: workResult.syncAction.action as ModelAction,
            data: workResult.data,
            modelId: workResult.syncAction.modelId,
            modelName: tx.modelName,
            payload: tx.payload,
            syncAction: { id: workResult.syncAction.id },
          });
        } catch (hookError) {
          warnings.push(
            `onAfterMutation hook failed: ${formatWarningMessage(hookError)}`
          );
          this.logger.warn(
            { error: hookError, modelName: tx.modelName },
            "onAfterMutation hook failed"
          );
        }
      }

      MutateService.publishSyncAction(workResult.syncAction, onAction);

      return {
        result: MutateService.createSuccessResult(
          tx,
          workResult.syncAction.id,
          warnings
        ),
        success: true,
        syncId: workResult.syncAction.id,
      };
    } catch (error) {
      if (isSyncDedupUniqueConstraintError(error)) {
        const duplicate = await this.dao.findSyncActionByClientTx(
          tx.clientId,
          tx.clientTxId
        );
        if (duplicate) {
          return MutateService.createDuplicateTransactionResult(
            tx,
            duplicate.id,
            this.logger
          );
        }
      }

      this.logger.error(
        {
          clientTxId: tx.clientTxId,
          error,
          modelId: tx.modelId,
          modelName: tx.modelName,
        },
        "Transaction failed"
      );
      return {
        result: {
          clientTxId: tx.clientTxId,
          error: error instanceof Error ? error.message : "Unknown error",
          success: false,
        },
        success: false,
      };
    }
  }

  async mutate(
    context: SyncUserContext,
    input: MutateInput,
    onAction?: (action: SyncActionOutput) => void
  ): Promise<MutateResult> {
    this.logger.info(
      {
        transactionCount: input.transactions.length,
        userId: context.userId,
      },
      "Mutate started"
    );

    const results: TransactionResult[] = [];
    let lastSyncId = 0n;
    let success = true;

    for (const tx of input.transactions) {
      const processed = await this.processTransaction(context, tx, onAction);
      results.push(processed.result);
      if (!processed.success) {
        success = false;
        continue;
      }
      if (processed.syncId > lastSyncId) {
        lastSyncId = processed.syncId;
      }
    }

    this.logger.info(
      {
        lastSyncId: serializeSyncId(lastSyncId),
        processedCount: results.length,
        success,
        userId: context.userId,
      },
      "Mutate completed"
    );

    return {
      lastSyncId: serializeSyncId(lastSyncId),
      results,
      success,
    };
  }
}
