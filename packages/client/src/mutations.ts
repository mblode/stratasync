import type {
  ArchiveTransactionOptions,
  ModelRegistry,
  Transaction,
  UnarchiveTransactionOptions,
} from "@stratasync/core";
import {
  captureArchiveState,
  createArchivePayload,
  createUnarchivePatch,
  createUnarchivePayload,
  generateUUID,
} from "@stratasync/core";

import type { HistoryEntry } from "./history-manager.js";
import type { IdentityMapRegistry } from "./identity-map.js";
import type { OutboxManager } from "./outbox-manager.js";
import type { ModelChangeAction } from "./types.js";
import { getModelData, pickOriginal } from "./utils.js";

interface TransactionCreatedHook {
  onTransactionCreated?: (tx: Transaction) => void;
}

type CreateOptions = TransactionCreatedHook;
type UpdateOptions = TransactionCreatedHook & {
  original?: Record<string, unknown>;
};
type DeleteOptions = TransactionCreatedHook & {
  original?: Record<string, unknown>;
};
type ArchiveOptions = ArchiveTransactionOptions & TransactionCreatedHook;
type UnarchiveOptions = UnarchiveTransactionOptions & TransactionCreatedHook;

const buildEffectiveUpdate = <T extends Record<string, unknown>>(
  existingData: T,
  changes: Partial<T>
): {
  effectiveChanges: Partial<T>;
  effectiveChangeRecord: Record<string, unknown>;
} => {
  const effectiveChanges: Partial<T> = {};
  for (const [key, value] of Object.entries(changes) as [
    keyof T,
    T[keyof T],
  ][]) {
    if (!Object.is(existingData[key as string], value)) {
      effectiveChanges[key] = value;
    }
  }

  return {
    effectiveChangeRecord: effectiveChanges as Record<string, unknown>,
    effectiveChanges,
  };
};

/**
 * Collaborators the mutation coordinator needs from the client composition
 * root. The coordinator owns the create/update/delete/archive/unarchive flows
 * so the client object, the model store, and history replay all route mutations
 * through it (eliminating the old clientRef self-reference hack).
 */
export interface MutationCoordinatorDeps {
  identityMaps: IdentityMapRegistry;
  getRegistry(): ModelRegistry;
  isOptimistic(): boolean;
  runWithMutationOutbox<T>(
    operation: (activeOutboxManager: OutboxManager) => Promise<T>
  ): Promise<T>;
  emitModelChange(
    modelName: string,
    modelId: string,
    action: ModelChangeAction
  ): void;
  serializeMutationRecord(
    modelName: string,
    data: Record<string, unknown>
  ): Record<string, unknown>;
  materialize<T extends Record<string, unknown>>(
    modelName: string,
    id: string,
    data: T,
    options?: { preferCached?: boolean }
  ): T;
  recordHistoryEntry(entry: HistoryEntry | null, queuedTx?: Transaction): void;
  buildHistoryEntry(
    action: Transaction["action"],
    modelName: string,
    modelId: string,
    payload: Record<string, unknown>,
    original?: Record<string, unknown>
  ): HistoryEntry | null;
  /** Inverts an optimistic mutation on the identity map after an outbox error. */
  rollbackOptimisticMutation(
    action: Transaction["action"],
    modelName: string,
    modelId: string,
    original?: Record<string, unknown>
  ): void;
  /** Removes a model from the missing-models set (a write resolves it). */
  markPresent(modelName: string, id: string): void;
}

export class MutationCoordinator {
  private readonly deps: MutationCoordinatorDeps;

  constructor(deps: MutationCoordinatorDeps) {
    this.deps = deps;
  }

  private requireExisting(
    modelName: string,
    id: string
  ): Record<string, unknown> {
    const map = this.deps.identityMaps.getMap(modelName);
    const existing = map.get(id);
    if (!existing) {
      throw new Error(`Model ${modelName} with id ${id} not found`);
    }
    return existing;
  }

  /**
   * Shared mutation core. The whole flow runs inside the mutation/outbox lock:
   * `prepare` derives the per-mutation descriptor (reading current identity-map
   * state under the lock, exactly as the inline flows did), then the optimistic
   * apply, the outbox enqueue (with rollback on failure), the
   * onTransactionCreated hook, and history recording run in order.
   */
  private executeMutation<T = void>(
    action: Transaction["action"],
    modelName: string,
    onTransactionCreated: ((tx: Transaction) => void) | undefined,
    prepare: () => {
      modelId: string;
      historyPayload: Record<string, unknown>;
      original?: Record<string, unknown>;
      optimisticApply: () => void;
      enqueue: (activeOutboxManager: OutboxManager) => Promise<Transaction>;
      produce?: () => T;
    }
  ): Promise<T> {
    return this.deps.runWithMutationOutbox(async (activeOutboxManager) => {
      const descriptor = prepare();
      const optimistic = this.deps.isOptimistic();
      if (optimistic) {
        descriptor.optimisticApply();
      }

      let queuedTx: Transaction;
      try {
        queuedTx = await descriptor.enqueue(activeOutboxManager);
      } catch (error) {
        if (optimistic) {
          this.deps.rollbackOptimisticMutation(
            action,
            modelName,
            descriptor.modelId,
            descriptor.original
          );
        }
        throw error;
      }
      onTransactionCreated?.(queuedTx);

      this.deps.recordHistoryEntry(
        this.deps.buildHistoryEntry(
          action,
          modelName,
          descriptor.modelId,
          descriptor.historyPayload,
          descriptor.original
        ),
        queuedTx
      );

      return descriptor.produce?.() as T;
    });
  }

  create<T extends Record<string, unknown>>(
    modelName: string,
    data: T,
    mutationOptions?: CreateOptions
  ): Promise<T> {
    return this.executeMutation<T>(
      "I",
      modelName,
      mutationOptions?.onTransactionCreated,
      () => {
        const primaryKey = this.deps.getRegistry().getPrimaryKey(modelName);
        const id = (data[primaryKey] as string) || generateUUID();
        const fullData = { ...data, [primaryKey]: id };
        const serializedFullData = this.deps.serializeMutationRecord(
          modelName,
          fullData
        );

        return {
          enqueue: (activeOutboxManager) =>
            activeOutboxManager.insert(modelName, id, serializedFullData),
          historyPayload: fullData,
          modelId: id,
          optimisticApply: () => {
            const map = this.deps.identityMaps.getMap<T>(modelName);
            map.set(id, fullData, { serialized: false });
            this.deps.markPresent(modelName, id);
            this.deps.emitModelChange(modelName, id, "insert");
          },
          produce: () =>
            this.deps.materialize(
              modelName,
              id,
              fullData as T & Record<string, unknown>
            ),
        };
      }
    );
  }

  update<T extends Record<string, unknown>>(
    modelName: string,
    id: string,
    changes: Partial<T>,
    mutationOptions?: UpdateOptions
  ): Promise<T> {
    return this.deps.runWithMutationOutbox(async (activeOutboxManager) => {
      const map = this.deps.identityMaps.getMap<T>(modelName);
      const existing = map.get(id);
      if (!existing) {
        throw new Error(`Model ${modelName} with id ${id} not found`);
      }

      const existingData = getModelData(existing) as T;
      const { effectiveChanges, effectiveChangeRecord } = buildEffectiveUpdate(
        existingData,
        changes
      );

      if (Object.keys(effectiveChangeRecord).length === 0) {
        return existing as T;
      }

      const originalSource = mutationOptions?.original ?? existingData;
      const original = pickOriginal(originalSource, effectiveChangeRecord);
      const serializedChanges = this.deps.serializeMutationRecord(
        modelName,
        effectiveChangeRecord
      );
      const serializedOriginal = this.deps.serializeMutationRecord(
        modelName,
        original
      );
      const updated = { ...existingData, ...effectiveChanges } as T;
      const optimistic = this.deps.isOptimistic();

      if (optimistic) {
        map.update(id, effectiveChanges, { serialized: false });
        this.deps.markPresent(modelName, id);
        this.deps.emitModelChange(modelName, id, "update");
      }

      let queuedTx: Transaction;
      try {
        queuedTx = await activeOutboxManager.update(
          modelName,
          id,
          serializedChanges,
          serializedOriginal
        );
      } catch (error) {
        if (optimistic) {
          this.deps.rollbackOptimisticMutation("U", modelName, id, original);
        }
        throw error;
      }
      mutationOptions?.onTransactionCreated?.(queuedTx);

      this.deps.recordHistoryEntry(
        this.deps.buildHistoryEntry(
          "U",
          modelName,
          id,
          effectiveChangeRecord,
          original
        ),
        queuedTx
      );

      return this.deps.materialize(
        modelName,
        id,
        updated as T & Record<string, unknown>,
        { preferCached: optimistic }
      );
    });
  }

  delete(
    modelName: string,
    id: string,
    mutationOptions?: DeleteOptions
  ): Promise<void> {
    return this.executeMutation(
      "D",
      modelName,
      mutationOptions?.onTransactionCreated,
      () => {
        const existing = this.requireExisting(modelName, id);
        const original = mutationOptions?.original ?? getModelData(existing);
        const serializedOriginal = this.deps.serializeMutationRecord(
          modelName,
          original
        );

        return {
          enqueue: (activeOutboxManager) =>
            activeOutboxManager.delete(modelName, id, serializedOriginal),
          historyPayload: {},
          modelId: id,
          optimisticApply: () => {
            this.deps.identityMaps.getMap(modelName).delete(id);
            this.deps.emitModelChange(modelName, id, "delete");
          },
          original,
        };
      }
    );
  }

  archive(
    modelName: string,
    id: string,
    mutationOptions?: ArchiveOptions
  ): Promise<void> {
    return this.executeMutation(
      "A",
      modelName,
      mutationOptions?.onTransactionCreated,
      () => {
        const existing = this.requireExisting(modelName, id);
        const existingData = getModelData(existing);
        const archived = createArchivePayload(mutationOptions?.archivedAt);
        const original =
          mutationOptions?.original ?? captureArchiveState(existingData);

        return {
          enqueue: (activeOutboxManager) =>
            activeOutboxManager.archive(modelName, id, {
              archivedAt: archived.archivedAt ?? undefined,
              original,
            }),
          historyPayload: archived,
          modelId: id,
          optimisticApply: () => {
            this.deps.identityMaps.getMap(modelName).update(id, archived);
            this.deps.emitModelChange(modelName, id, "archive");
          },
          original,
        };
      }
    );
  }

  unarchive(
    modelName: string,
    id: string,
    mutationOptions?: UnarchiveOptions
  ): Promise<void> {
    return this.executeMutation(
      "V",
      modelName,
      mutationOptions?.onTransactionCreated,
      () => {
        const existing = this.requireExisting(modelName, id);
        const existingData = getModelData(existing);
        const original =
          mutationOptions?.original ?? captureArchiveState(existingData);
        const unarchivePatch = createUnarchivePatch();

        return {
          enqueue: (activeOutboxManager) =>
            activeOutboxManager.unarchive(modelName, id, { original }),
          historyPayload: createUnarchivePayload(),
          modelId: id,
          optimisticApply: () => {
            this.deps.identityMaps.getMap(modelName).update(id, unarchivePatch);
            this.deps.emitModelChange(modelName, id, "unarchive");
          },
          original,
        };
      }
    );
  }
}
