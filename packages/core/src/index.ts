// biome-ignore-all lint/performance/noBarrelFile: This is the package's main entry point

export { Model } from "./model/base-model.js";
export {
  makeObservableProperty,
  makeReferenceModelProperty,
  setBoxFactory,
} from "./model/observability.js";
export type {
  DisposeFn,
  ObservableArray,
  ObservableBox,
  ObservableMap,
  ObservableOptions,
  ReactionOptions,
  ReactivityAdapter,
} from "./reactivity/adapter.js";
export { noopReactivityAdapter } from "./reactivity/adapter.js";
export {
  BackReference,
  ClientModel,
  OneToMany,
  Property,
  Reference,
  ReferenceArray,
} from "./schema/decorators.js";
export { computeSchemaHash } from "./schema/hash.js";
export { ModelRegistry } from "./schema/registry.js";
export type {
  ModelMetadata,
  ModelRegistrySnapshot,
  SchemaDefinition,
  TransactionAction,
} from "./schema/types.js";
export type { SerializedModelData, SyncStore } from "./store/types.js";
export { applyDeltas } from "./sync/delta-applier.js";
export type { RebaseConflict, RebaseOptions } from "./sync/rebase.js";
export { rebaseTransactions } from "./sync/rebase.js";
export type { SyncId } from "./sync/sync-id.js";
export {
  compareSyncId,
  isSyncIdGreaterThan,
  maxSyncId,
  ZERO_SYNC_ID,
} from "./sync/sync-id.js";
export type {
  BatchLoadOptions,
  BatchRequest,
  BootstrapMetadata,
  BootstrapOptions,
  ConnectionState,
  DeltaPacket,
  DeltaSubscription,
  ModelRow,
  SubscribeOptions,
  SyncAction,
  SyncActionType,
  SyncClientState,
} from "./sync/types.js";
export type {
  ArchiveTransactionOptions,
  UnarchiveTransactionOptions,
} from "./transaction/archive.js";
export {
  captureArchiveState,
  createArchivePayload,
  createUnarchivePatch,
  createUnarchivePayload,
  readArchivedAt,
} from "./transaction/archive.js";
export {
  createArchiveTransaction,
  createDeleteTransaction,
  createInsertTransaction,
  createTransactionBatch,
  createUnarchiveTransaction,
  createUndoTransaction,
  createUpdateTransaction,
} from "./transaction/create.js";
export type {
  MutateResult,
  Transaction,
  TransactionBatch,
  TransactionResult,
  TransactionState,
} from "./transaction/types.js";
export { generateUUID, getOrCreateClientId } from "./utils/idempotency.js";
