import type { SyncLogger, SyncModelConfig } from "../config.js";
import { noopLogger } from "../config.js";
import type { RawSyncActionRow } from "../core/sync-action.js";
import { toSyncActionOutput } from "../core/sync-action.js";
import { serializeSyncId } from "../core/sync-id.js";
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
import { buildModelRegistry } from "./model-registry.js";
import type {
  GroupResolver,
  ModelHandler,
  ModelLookup,
} from "./model-registry.js";

const SYNC_ACTION_DEDUP_CONSTRAINT =
  "sync_actions_client_id_client_tx_id_unique";

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
  syncAction: RawSyncActionRow;
  /** Group the creator was granted by this insert, else null. */
  grantedGroupId: string | null;
}

interface AuthorizedGroup {
  groupId: string | null;
  grantedGroupId: string | null;
}

type ProcessAction = ReturnType<typeof mapGraphQLAction>;

interface PreparedTransaction {
  action: ProcessAction;
  canonicalModelId: string;
  modelConfig: SyncModelConfig | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class MutateService {
  private readonly dao: SyncDao;
  private readonly db: SyncDb;
  private readonly logger: SyncLogger;
  private readonly modelHandlers: Map<string, ModelHandler>;
  private readonly groupResolvers: Record<string, GroupResolver>;
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

    const registry = buildModelRegistry(models);
    this.modelHandlers = registry.handlers;
    this.groupResolvers = registry.groupResolvers;
    this.modelDelegates = registry.delegates;
    this.modelConfigs = registry.configs;
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
    tx: TransactionInput,
    prepared: PreparedTransaction,
    record: Record<string, unknown> | null,
    context: SyncUserContext
  ): Promise<string | null> {
    const resolver = this.groupResolvers[tx.modelName];
    if (!resolver) {
      return null;
    }

    try {
      return await resolver({
        action: prepared.action,
        context,
        db,
        modelId: prepared.canonicalModelId,
        modelName: tx.modelName,
        payload: tx.payload,
        record,
      });
    } catch (error) {
      this.logger.warn(
        { error, modelId: prepared.canonicalModelId, modelName: tx.modelName },
        "Could not resolve group for mutation"
      );
      throw error;
    }
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

  /**
   * Loads the row a non-insert mutation targets, asserting it exists.
   *
   * The row is returned rather than discarded so group resolution can reuse it:
   * previously this lookup and the one inside group resolution were two
   * separate queries for the same row on every update, delete and archive.
   */
  private async loadMutationTarget(
    db: SyncDb,
    tx: TransactionInput,
    prepared: PreparedTransaction
  ): Promise<Record<string, unknown> | null> {
    if (prepared.action === "I") {
      return null;
    }

    if (prepared.modelConfig?.mutate.kind !== "standard") {
      return null;
    }

    const row = await this.lookupModelRecord(
      db,
      tx.modelName,
      prepared.canonicalModelId
    );
    if (!row) {
      throw new Error("Invalid mutation: record not found");
    }

    return row;
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

  /**
   * Grants the creator membership of a group their INSERT is opening.
   *
   * Only ever reached for `action === "I"` on a model that opts in with
   * `insertCreatesGroup`, and only when the resolved group is one the caller
   * does not already belong to. The membership row is written on `db`, which is
   * the transaction handle, so it commits or rolls back with the row itself.
   *
   * Returns true when membership was granted, which is the signal to skip
   * `validateGroupAccess` for this one write.
   */
  private async grantInsertGroup(
    db: SyncDb,
    context: SyncUserContext,
    tx: TransactionInput,
    prepared: PreparedTransaction,
    groupId: string | null
  ): Promise<boolean> {
    if (
      prepared.action !== "I" ||
      groupId === null ||
      !prepared.modelConfig?.insertCreatesGroup ||
      context.groups.includes(groupId)
    ) {
      return false;
    }

    // Guaranteed present: buildModelRegistry rejects insertCreatesGroup
    // without an explicit groupType at startup.
    const groupType = prepared.modelConfig.groupType ?? tx.modelName;
    await this.dao
      .withDb(db)
      .addGroupMembership(context.userId, groupId, groupType);

    this.logger.info(
      { groupId, groupType, modelName: tx.modelName, userId: context.userId },
      "Insert opened a new sync group"
    );

    return true;
  }

  private async resolveAuthorizedGroupId(
    db: SyncDb,
    context: SyncUserContext,
    tx: TransactionInput,
    prepared: PreparedTransaction,
    record: Record<string, unknown> | null
  ): Promise<AuthorizedGroup> {
    const groupId = await this.resolveGroupId(
      db,
      tx,
      prepared,
      record,
      context
    );

    if (await this.grantInsertGroup(db, context, tx, prepared, groupId)) {
      return { grantedGroupId: groupId, groupId };
    }

    MutateService.validateGroupAccess(
      context,
      groupId,
      tx.modelName,
      this.logger
    );

    return { grantedGroupId: null, groupId };
  }

  private static publishSyncAction(
    syncAction: RawSyncActionRow,
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
  ): Promise<RawSyncActionRow> {
    return await dao.createSyncAction({
      action,
      clientId: tx.clientId,
      clientTxId: tx.clientTxId,
      data,
      groupId,
      model: tx.modelName,
      modelId: canonicalModelId,
    });
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
        const record = await this.loadMutationTarget(txDb, tx, prepared);
        const { grantedGroupId, groupId } = await this.resolveAuthorizedGroupId(
          txDb,
          context,
          tx,
          prepared,
          record
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
          grantedGroupId,
          syncAction,
        } satisfies TransactionWorkResult;
      });

      // Widen the batch's working groups only once the membership row has
      // actually committed, so later transactions in the same batch validate
      // against a group that exists. A rolled-back insert widens nothing.
      if (
        workResult.grantedGroupId !== null &&
        !context.groups.includes(workResult.grantedGroupId)
      ) {
        context.groups.push(workResult.grantedGroupId);
      }

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

    // An insert that opens a group widens the groups this batch may write to.
    // That widening is scoped to the batch: the caller's context is an input,
    // not a scratchpad, and mutating it would leak a grant into whatever else
    // holds a reference to it.
    const batchContext: SyncUserContext = {
      ...context,
      groups: [...context.groups],
    };

    for (const tx of input.transactions) {
      const processed = await this.processTransaction(
        batchContext,
        tx,
        onAction
      );
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
