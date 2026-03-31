// Types
export type {
  BootstrapRequest,
  DeltaPacket,
  GraphQLTransactionAction,
  ModelAction,
  MutateInput,
  MutateResult,
  SerializedSyncActionOutput,
  SyncActionOutput,
  SyncIdString,
  SyncUserContext,
  TransactionInput,
  TransactionResult,
} from "./types.js";
export { mapGraphQLAction } from "./types.js";

// Config types
export type {
  BootstrapFieldDef,
  BootstrapFilterContext,
  BootstrapModelConfig,
  CompositeMutateConfig,
  CursorConfig,
  FieldSpec,
  FieldType,
  MutationContext,
  RedisClient,
  StandardMutateConfig,
  SyncAuthConfig,
  SyncAuthPayload,
  SyncLogger,
  SyncModelConfig,
  SyncServer,
  SyncServerConfig,
  WebSocketConnectionContext,
  WebSocketHooks,
} from "./config.js";
export { noopLogger } from "./config.js";

// Utilities
export {
  dateOnlyStringToEpoch,
  epochToDateOnlyString,
  toDateOnlyDateOrNull,
  toDateOnlyEpoch,
  toDateOnlyStringOrNull,
  toInstantDateOrNull,
  toInstantEpoch,
} from "./utils/dates.js";

export {
  getColumn,
  parseSyncActionOutput,
  parseSyncIdString,
  serializeSyncActionOutput,
  serializeSyncId,
  toSyncActionOutput,
} from "./utils/sync-utils.js";

export {
  dedupeSyncGroups,
  resolvePublishedDeltaGroups,
  resolveRequestedSyncGroups,
} from "./utils/sync-scope.js";

export {
  createCompositeSyncId,
  DEFAULT_COMPOSITE_ID_NAMESPACE,
} from "./utils/composite-ids.js";

// Database type
export type { SyncDb, SyncDbSelectBuilder, SyncDbWhereResult } from "./db.js";

// DAO
export { SyncDao } from "./dao/sync-dao.js";
export type { SyncActionInsert, SyncDaoTables } from "./dao/sync-dao.js";

// Delta publisher
export type {
  DeltaPublisherLike,
  DeltaSubscriberCallback,
  DeltaSubscriberLike,
} from "./delta/delta-publisher.js";
export {
  createCompositeDeltaPublisher,
  createDeltaPublisher,
  createDeltaSubscriber,
  createInMemoryDeltaBus,
  createInMemoryDeltaPublisher,
  createInMemoryDeltaSubscriber,
  safeJsonStringify,
} from "./delta/delta-publisher.js";

// Field codecs
export {
  buildInsertData,
  buildUpdateData,
  parseTemporalInput,
  serializeSyncData,
} from "./mutate/field-codecs.js";

// Archive mutation
export { handleArchiveMutation } from "./mutate/archive-mutation.js";

// Model handlers
export type {
  ModelDef,
  MutationDelegate,
  StandardModelDef,
  CompositeModelDef,
} from "./mutate/model-handlers.js";
export {
  createCompositeDelegate,
  createModelHandler,
  createStandardDelegate,
} from "./mutate/model-handlers.js";

// Schema inference
export type {
  InferredBootstrapFields,
  InferredMutateFields,
  InferredTableFields,
} from "./schema/infer-model.js";
export { inferTableFields } from "./schema/infer-model.js";

// Services
export { BootstrapService } from "./bootstrap/bootstrap-service.js";
export { DeltaService } from "./delta/delta-service.js";
export { MutateService } from "./mutate/mutate-service.js";

// Factory
export { createSyncServer } from "./create-sync-server.js";
