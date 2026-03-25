/**
 * Sync action types
 */
type TransactionAction = "I" | "U" | "D" | "A" | "V";
export type GraphQLTransactionAction =
  | "INSERT"
  | "UPDATE"
  | "DELETE"
  | "ARCHIVE"
  | "UNARCHIVE";

const assertNever = (_value: never, message: string): never => {
  throw new Error(message);
};

/**
 * Maps GraphQL action names to internal codes
 */
export const mapGraphQLAction = (
  action: GraphQLTransactionAction
): TransactionAction => {
  switch (action) {
    case "INSERT": {
      return "I";
    }
    case "UPDATE": {
      return "U";
    }
    case "DELETE": {
      return "D";
    }
    case "ARCHIVE": {
      return "A";
    }
    case "UNARCHIVE": {
      return "V";
    }
    default: {
      return assertNever(action, `Unsupported action: ${action}`);
    }
  }
};

/**
 * Transaction input for mutations
 */
export interface TransactionInput {
  clientTxId: string;
  clientId: string;
  modelName: string;
  modelId: string;
  action: GraphQLTransactionAction;
  payload: Record<string, unknown>;
}

/**
 * Mutation batch input
 */
export interface MutateInput {
  batchId: string;
  transactions: TransactionInput[];
}

/**
 * Transaction result
 */
export interface TransactionResult {
  clientTxId: string;
  success: boolean;
  syncId?: string;
  error?: string;
  warnings?: string[];
}

/**
 * Mutation result
 */
export interface MutateResult {
  success: boolean;
  lastSyncId: string;
  results: TransactionResult[];
}

export type SyncIdString = string;

/**
 * Delta packet for sync
 */
export interface DeltaPacket {
  lastSyncId: SyncIdString;
  hasMore: boolean;
  actions: SyncActionOutput[];
}

/**
 * Sync action output
 */
export interface SyncActionOutput {
  syncId: SyncIdString;
  modelName: string;
  modelId: string;
  action: string;
  data: Record<string, unknown>;
  groupId?: string;
  clientTxId?: string;
  clientId?: string;
  createdAt: Date;
}

export interface SerializedSyncActionOutput {
  syncId: SyncIdString;
  modelName: string;
  modelId: string;
  action: string;
  data: Record<string, unknown>;
  groupId?: string;
  clientTxId?: string;
  clientId?: string;
  createdAt: string;
}

/**
 * Bootstrap request
 */
export interface BootstrapRequest {
  firstSyncId?: string;
  noSyncPackets?: boolean;
  schemaHash: string;
  groups?: string[];
  models?: string[];
  type?: "full" | "partial";
}

/**
 * Sync user context
 */
export interface SyncUserContext {
  userId: string;
  groups: string[];
  email?: string;
  name?: string | null;
}

/**
 * Model action type
 */
export type ModelAction = "I" | "U" | "D" | "A" | "V";
