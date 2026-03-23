import {
  createArchivePayload,
  createUnarchivePatch,
  readArchivedAt,
} from "../transaction/archive.js";
import type { SyncId } from "./sync-id.js";
import { maxSyncId, ZERO_SYNC_ID } from "./sync-id.js";
import type { DeltaPacket, SyncAction } from "./types.js";

/**
 * Result of applying deltas to local state
 */
export interface ApplyResult {
  /** Number of inserts applied */
  inserts: number;
  /** Number of updates applied */
  updates: number;
  /** Number of deletes applied */
  deletes: number;
  /** Number of archives applied */
  archives: number;
  /** Number of unarchives applied */
  unarchives: number;
  /** Highest sync ID applied */
  lastSyncId: SyncId;
  /** Actions that were skipped (e.g., own client transactions) */
  skipped: number;
}

/**
 * Interface for the data store that receives delta changes
 */
export interface DeltaTarget {
  /** Insert or replace a model row */
  put(
    modelName: string,
    id: string,
    data: Record<string, unknown>
  ): Promise<void>;
  /** Delete a model row */
  delete(modelName: string, id: string): Promise<void>;
  /** Update specific fields on a model row */
  patch(
    modelName: string,
    id: string,
    changes: Record<string, unknown>
  ): Promise<void>;
  /** Get a model row */
  get(modelName: string, id: string): Promise<Record<string, unknown> | null>;
}

/**
 * Options for applying deltas
 */
export interface ApplyOptions {
  /** Client ID to skip own transactions */
  clientId?: string;
  /** Whether to merge updates or replace */
  mergeUpdates?: boolean;
}

/**
 * Applies a delta packet to the local data store
 */
interface RegistryLike {
  hasModel(modelName: string): boolean;
}

/**
 * Merges data into an existing row and writes it back.
 */
const mergeAndPut = async (
  target: DeltaTarget,
  modelName: string,
  modelId: string,
  data: Record<string, unknown>,
  overrides?: Record<string, unknown>
): Promise<void> => {
  const existing = await target.get(modelName, modelId);
  await target.put(modelName, modelId, {
    ...existing,
    ...data,
    ...overrides,
  });
};

/**
 * Applies a single sync action to the target
 */
const applySingleAction = async (
  action: SyncAction,
  target: DeltaTarget,
  options: ApplyOptions
): Promise<boolean> => {
  const { modelName, modelId, data } = action;

  switch (action.action) {
    case "I": {
      await target.put(modelName, modelId, data);
      return true;
    }

    case "U": {
      if (options.mergeUpdates) {
        await target.patch(modelName, modelId, data);
        return true;
      }
      const existing = await target.get(modelName, modelId);
      if (!existing) {
        return false;
      }
      await target.put(modelName, modelId, {
        ...existing,
        ...data,
      });
      return true;
    }

    case "D": {
      await target.delete(modelName, modelId);
      return true;
    }

    case "A": {
      await mergeAndPut(
        target,
        modelName,
        modelId,
        data,
        createArchivePayload(readArchivedAt(data))
      );
      return true;
    }

    case "V": {
      await mergeAndPut(
        target,
        modelName,
        modelId,
        data,
        createUnarchivePatch()
      );
      return true;
    }
    default: {
      return false;
    }
  }
};

/**
 * Updates the result counters based on action type
 */
const updateResult = (result: ApplyResult, action: SyncAction): void => {
  const actionSyncId = action.id;
  result.lastSyncId = maxSyncId(result.lastSyncId, actionSyncId);

  switch (action.action) {
    case "I": {
      result.inserts += 1;
      break;
    }
    case "U": {
      result.updates += 1;
      break;
    }
    case "D": {
      result.deletes += 1;
      break;
    }
    case "A": {
      result.archives += 1;
      break;
    }
    case "V": {
      result.unarchives += 1;
      break;
    }
    default: {
      break;
    }
  }
};

const markSkipped = (result: ApplyResult, actionSyncId: SyncId): void => {
  result.skipped += 1;
  result.lastSyncId = maxSyncId(result.lastSyncId, actionSyncId);
};

export const applyDeltas = async (
  packet: DeltaPacket,
  target: DeltaTarget,
  registry: RegistryLike,
  options: ApplyOptions = {}
): Promise<ApplyResult> => {
  const result: ApplyResult = {
    archives: 0,
    deletes: 0,
    inserts: 0,
    lastSyncId: ZERO_SYNC_ID,
    skipped: 0,
    unarchives: 0,
    updates: 0,
  };

  for (const action of packet.actions) {
    // Skip actions from our own client (we already applied them optimistically)
    const actionSyncId = action.id;

    if (options.clientId && action.clientId === options.clientId) {
      markSkipped(result, actionSyncId);
      continue;
    }

    // Verify model exists in schema
    if (!registry.hasModel(action.modelName)) {
      markSkipped(result, actionSyncId);
      continue;
    }

    const applied = await applySingleAction(action, target, options);
    if (!applied) {
      markSkipped(result, actionSyncId);
      continue;
    }

    updateResult(result, action);
  }

  return result;
};
