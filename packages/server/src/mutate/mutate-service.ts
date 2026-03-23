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

interface CreateSyncActionResult {
  syncAction: SyncActionRow | null;
  duplicateId: bigint | null;
}

type ProcessAction = ReturnType<typeof mapGraphQLAction>;

interface PreparedTransaction {
  action: ProcessAction;
  canonicalModelId: string;
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
  private readonly db: unknown;
  private readonly logger: SyncLogger;
  private readonly modelHandlers: Map<
    string,
    (
      db: unknown,
      modelId: string,
      payload: Record<string, unknown>,
      action: ModelAction
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
    this.db = db;
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
  private async resolveGroupId(
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

    // Try payload first
    const payloadValue = payload[groupKey];
    if (typeof payloadValue === "string" && payloadValue.length > 0) {
      return payloadValue;
    }

    // For insert, the group key is required in payload
    if (action === "I") {
      this.logger.warn(
        { groupKey, modelName },
        "Missing group key in insert payload"
      );
      throw new Error("Invalid mutation: missing required group identifier");
    }

    // For update/delete/archive/unarchive, look up from DB
    const record = await this.lookupGroupId(modelName, modelId, groupKey);
    if (!record) {
      this.logger.warn(
        { groupKey, modelId, modelName },
        "Cannot resolve group for mutation"
      );
      throw new Error("Invalid mutation: record not found");
    }
    return record;
  }

  private async lookupGroupId(
    modelName: string,
    modelId: string,
    groupKey: string
  ): Promise<string | null> {
    const lookup = this.modelDelegates[modelName];
    if (!lookup) {
      return null;
    }

    const row = await lookup(this.db, modelId);
    return (row as Record<string, unknown> | null)?.[groupKey] as string | null;
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
    };
  }

  private async applyModelMutation(
    tx: TransactionInput,
    prepared: PreparedTransaction
  ): Promise<Record<string, unknown>> {
    const handler = this.modelHandlers.get(tx.modelName);

    if (!handler) {
      return tx.payload;
    }

    return await handler(
      this.db,
      prepared.canonicalModelId,
      tx.payload,
      prepared.action
    );
  }

  private async resolveAuthorizedGroupId(
    context: SyncUserContext,
    tx: TransactionInput,
    prepared: PreparedTransaction
  ): Promise<string | null> {
    const groupId = await this.resolveGroupId(
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
    syncId: bigint
  ): TransactionResult {
    return {
      clientTxId: tx.clientTxId,
      success: true,
      syncId: serializeSyncId(syncId),
    };
  }

  private async createSyncActionWithDeduplication(
    tx: TransactionInput,
    action: string,
    canonicalModelId: string,
    data: Record<string, unknown>,
    groupId: string | null
  ): Promise<CreateSyncActionResult> {
    try {
      const syncAction = await this.dao.createSyncAction({
        action,
        clientId: tx.clientId,
        clientTxId: tx.clientTxId,
        data,
        groupId,
        model: tx.modelName,
        modelId: canonicalModelId,
      });
      return {
        duplicateId: null,
        syncAction: syncAction as unknown as SyncActionRow,
      };
    } catch (error) {
      if (!isSyncDedupUniqueConstraintError(error)) {
        throw error;
      }
      const duplicate = await this.dao.findSyncActionByClientTx(
        tx.clientId,
        tx.clientTxId
      );
      if (!duplicate) {
        throw error;
      }
      return { duplicateId: duplicate.id, syncAction: null };
    }
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

      const prepared = this.prepareTransaction(tx);
      const data = await this.applyModelMutation(tx, prepared);
      const groupId = await this.resolveAuthorizedGroupId(
        context,
        tx,
        prepared
      );

      const createResult = await this.createSyncActionWithDeduplication(
        tx,
        prepared.action,
        prepared.canonicalModelId,
        data,
        groupId
      );

      if (createResult.duplicateId !== null) {
        return MutateService.createDuplicateTransactionResult(
          tx,
          createResult.duplicateId,
          this.logger
        );
      }

      const { syncAction } = createResult;
      if (!syncAction) {
        throw new Error("Expected syncAction after transaction creation");
      }

      this.logger.debug(
        {
          action: prepared.action,
          modelId: prepared.canonicalModelId,
          modelName: tx.modelName,
          syncId: serializeSyncId(syncAction.id),
        },
        "Transaction processed"
      );

      MutateService.publishSyncAction(syncAction, onAction);

      // Fire onAfterMutation hook
      const modelConfig = this.modelConfigs[tx.modelName];
      if (modelConfig?.mutate.onAfterMutation) {
        try {
          await modelConfig.mutate.onAfterMutation({
            action: prepared.action,
            data,
            modelId: prepared.canonicalModelId,
            modelName: tx.modelName,
            payload: tx.payload,
            syncAction: { id: syncAction.id },
          });
        } catch (hookError) {
          this.logger.warn(
            { error: hookError, modelName: tx.modelName },
            "onAfterMutation hook failed"
          );
        }
      }

      return {
        result: MutateService.createSuccessResult(tx, syncAction.id),
        success: true,
        syncId: syncAction.id,
      };
    } catch (error) {
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
