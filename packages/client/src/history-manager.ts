import type { TransactionAction } from "@stratasync/core";
import {
  captureArchiveState,
  createArchivePayload,
  createUnarchivePatch,
  createUnarchivePayload,
} from "@stratasync/core";

export interface HistoryOperation {
  action: TransactionAction;
  modelName: string;
  modelId: string;
  payload: Record<string, unknown>;
  original?: Record<string, unknown>;
}

export interface HistoryEntry {
  undo: HistoryOperation;
  redo: HistoryOperation;
}

interface HistoryGroup {
  entries: HistoryEntry[];
  txIds: string[];
}

interface CapturedHistoryGroup extends HistoryGroup {
  invalidated: boolean;
}

/**
 * Manages undo/redo history for sync client mutations.
 *
 * Each mutation produces a HistoryEntry with inverse operations.
 * Undo pops from the undo stack and applies the inverse, pushing to redo.
 * Redo pops from the redo stack and re-applies, pushing to undo.
 */
export class HistoryManager {
  private readonly undoStack: HistoryGroup[] = [];
  private readonly redoStack: HistoryGroup[] = [];
  private readonly captureStack: CapturedHistoryGroup[] = [];
  private suppressHistory = false;

  record(entry: HistoryEntry | null, txId?: string): void {
    if (!entry || this.suppressHistory) {
      return;
    }
    const activeGroup = this.captureStack.at(-1);
    if (activeGroup) {
      if (activeGroup.invalidated) {
        return;
      }
      activeGroup.entries.push(entry);
      if (txId) {
        activeGroup.txIds.push(txId);
      }
      return;
    }

    this.pushGroup({
      entries: [entry],
      txIds: txId ? [txId] : [],
    });
  }

  async runAsGroup<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.suppressHistory) {
      return await operation();
    }

    const group: CapturedHistoryGroup = {
      entries: [],
      invalidated: false,
      txIds: [],
    };
    this.captureStack.push(group);
    let result!: T;
    let caughtError: unknown;

    try {
      result = await operation();
    } catch (error) {
      caughtError = error;
    }

    const completedGroup = this.captureStack.pop();
    if (completedGroup && completedGroup.entries.length > 0) {
      const parentGroup = this.captureStack.at(-1);
      if (parentGroup) {
        parentGroup.entries.push(...completedGroup.entries);
        parentGroup.txIds.push(...completedGroup.txIds);
      } else {
        this.pushGroup(completedGroup);
      }
    }

    if (caughtError) {
      // oxlint-disable-next-line no-throw-literal
      throw caughtError;
    }

    return result;
  }

  private pushGroup(group: HistoryGroup): void {
    if (group.entries.length === 0) {
      return;
    }

    this.undoStack.push({
      entries: [...group.entries],
      txIds: [...group.txIds],
    });
    this.redoStack.length = 0;
  }

  removeByTxId(clientTxId: string): void {
    if (this.captureStack.some((group) => group.txIds.includes(clientTxId))) {
      for (const group of this.captureStack) {
        group.entries.length = 0;
        group.invalidated = true;
        group.txIds.length = 0;
      }
    }

    const removeMatches = (stack: HistoryGroup[]): void => {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i]?.txIds.includes(clientTxId)) {
          stack.splice(i, 1);
        }
      }
    };
    removeMatches(this.undoStack);
    removeMatches(this.redoStack);
  }

  // eslint-disable-next-line class-methods-use-this -- called via instance from client.ts
  buildEntry(
    action: TransactionAction,
    modelName: string,
    modelId: string,
    payload: Record<string, unknown>,
    original?: Record<string, unknown>
  ): HistoryEntry | null {
    const redo: HistoryOperation = {
      action,
      modelId,
      modelName,
      original,
      payload,
    };

    let undo: HistoryOperation | null = null;

    switch (action) {
      case "I": {
        undo = {
          action: "D",
          modelId,
          modelName,
          original: payload,
          payload: {},
        };
        break;
      }
      case "D": {
        if (original) {
          undo = {
            action: "I",
            modelId,
            modelName,
            payload: original,
          };
        }
        break;
      }
      case "U": {
        if (original) {
          undo = {
            action: "U",
            modelId,
            modelName,
            original: payload,
            payload: original,
          };
        }
        break;
      }
      case "A": {
        undo = {
          action: "V",
          modelId,
          modelName,
          original: captureArchiveState(payload),
          payload: createUnarchivePayload(),
        };
        break;
      }
      case "V": {
        undo = {
          action: "A",
          modelId,
          modelName,
          original: createUnarchivePatch(),
          payload: createArchivePayload(
            captureArchiveState(original).archivedAt ?? undefined
          ),
        };
        break;
      }
      default: {
        break;
      }
    }

    if (!undo) {
      return null;
    }
    return { redo, undo };
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Pops the last undo entry and applies the inverse operation.
   * The applyOp callback executes the operation and returns the transaction ID.
   */
  async undo(
    applyOp: (op: HistoryOperation) => Promise<string | undefined>
  ): Promise<void> {
    const group = this.undoStack.pop();
    if (!group) {
      return;
    }

    this.suppressHistory = true;
    const appliedEntries: HistoryEntry[] = [];
    try {
      const nextTxIds: string[] = [];
      for (let i = group.entries.length - 1; i >= 0; i -= 1) {
        const entry = group.entries[i];
        if (!entry) {
          continue;
        }

        const txId = await applyOp(entry.undo);
        appliedEntries.push(entry);
        if (txId) {
          nextTxIds.push(txId);
        }
      }
      group.txIds = nextTxIds;
      this.redoStack.push(group);
    } catch (error) {
      await HistoryManager.rollbackHistoryEntries(
        appliedEntries,
        "undo",
        applyOp
      );
      this.undoStack.push(group);
      throw error;
    } finally {
      this.suppressHistory = false;
    }
  }

  /**
   * Pops the last redo entry and re-applies the operation.
   * The applyOp callback executes the operation and returns the transaction ID.
   */
  async redo(
    applyOp: (op: HistoryOperation) => Promise<string | undefined>
  ): Promise<void> {
    const group = this.redoStack.pop();
    if (!group) {
      return;
    }

    this.suppressHistory = true;
    const appliedEntries: HistoryEntry[] = [];
    try {
      const nextTxIds: string[] = [];
      for (const entry of group.entries) {
        const txId = await applyOp(entry.redo);
        appliedEntries.push(entry);
        if (txId) {
          nextTxIds.push(txId);
        }
      }
      group.txIds = nextTxIds;
      this.undoStack.push(group);
    } catch (error) {
      await HistoryManager.rollbackHistoryEntries(
        appliedEntries,
        "redo",
        applyOp
      );
      this.redoStack.push(group);
      throw error;
    } finally {
      this.suppressHistory = false;
    }
  }

  private static async rollbackHistoryEntries(
    entries: HistoryEntry[],
    direction: "undo" | "redo",
    applyOp: (op: HistoryOperation) => Promise<string | undefined>
  ): Promise<void> {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (!entry) {
        continue;
      }

      const rollbackOperation = direction === "undo" ? entry.redo : entry.undo;

      try {
        await applyOp(rollbackOperation);
      } catch {
        // Best-effort rollback: preserve the original failure while
        // attempting to restore local state for the operations that ran.
      }
    }
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.captureStack.length = 0;
  }
}
