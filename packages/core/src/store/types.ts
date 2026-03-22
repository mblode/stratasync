import type {
  ArchiveTransactionOptions,
  UnarchiveTransactionOptions,
} from "../transaction/archive.js";

export interface SyncStore {
  get(modelName: string, id: string): unknown | Promise<unknown>;
  create?(
    modelName: string,
    data: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  update?(
    modelName: string,
    id: string,
    changes: Record<string, unknown>,
    options?: { original?: Record<string, unknown> }
  ): Promise<Record<string, unknown>>;
  delete?(
    modelName: string,
    id: string,
    options?: { original?: Record<string, unknown> }
  ): Promise<void>;
  archive?(
    modelName: string,
    id: string,
    options?: ArchiveTransactionOptions
  ): Promise<void>;
  unarchive?(
    modelName: string,
    id: string,
    options?: UnarchiveTransactionOptions
  ): Promise<void>;
}
