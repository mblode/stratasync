import type {
  ArchiveTransactionOptions,
  UnarchiveTransactionOptions,
} from "../transaction/archive.js";

/**
 * Serialized model data as persisted in storage or sent over the wire.
 * Values in this shape should already have property serializers applied.
 */
export type SerializedModelData = Record<string, unknown>;

export interface SyncStore {
  /** Returns a serialized row for the requested model. */
  get(modelName: string, id: string): unknown | Promise<unknown>;
  getCached?(modelName: string, id: string): unknown | null;
  getAll?(modelName: string): unknown[];
  /** Persists and returns a serialized row. */
  create?(
    modelName: string,
    data: SerializedModelData
  ): Promise<SerializedModelData>;
  /** Applies serialized changes and returns the serialized canonical row. */
  update?(
    modelName: string,
    id: string,
    changes: SerializedModelData,
    options?: { original?: SerializedModelData }
  ): Promise<SerializedModelData>;
  /** Deletes a model row using a serialized original snapshot. */
  delete?(
    modelName: string,
    id: string,
    options?: { original?: SerializedModelData }
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
