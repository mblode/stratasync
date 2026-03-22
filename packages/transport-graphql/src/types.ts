import type { Transaction } from "@stratasync/core";

/**
 * Authentication provider interface
 */
export interface AuthProvider {
  /** Gets the current access token */
  getAccessToken(): Promise<string | null>;
  /** Refreshes the access token */
  refreshToken?(): Promise<string | null>;
  /** Called when auth fails */
  onAuthError?(error: Error): void;
}

/**
 * Transport adapter options
 */
export interface TransportOptions {
  /** GraphQL endpoint URL */
  endpoint: string;
  /** Base REST sync endpoint (e.g., https://api.example.com/sync) */
  syncEndpoint: string;
  /** WebSocket endpoint for subscriptions */
  wsEndpoint: string;
  /** Authentication provider */
  auth: AuthProvider;
  /** GraphQL mutation builder */
  mutationBuilder?: GraphQLMutationBuilder;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Retry configuration */
  retry?: RetryConfig;
  /** Custom headers */
  headers?: Record<string, string>;
  /** Custom WebSocket implementation (for non-browser environments) */
  webSocketFactory?: typeof WebSocket;
}

/**
 * Retry configuration
 */
export interface RetryConfig {
  /** Maximum number of retries */
  maxRetries: number;
  /** Base delay in milliseconds */
  baseDelay: number;
  /** Maximum delay in milliseconds */
  maxDelay: number;
  /** Jitter factor (0-1) */
  jitter?: number;
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  baseDelay: 1000,
  jitter: 0.2,
  maxDelay: 30_000,
  maxRetries: 3,
};

/**
 * GraphQL error structure
 */
export interface GraphQLError {
  message: string;
  locations?: { line: number; column: number }[];
  path?: (string | number)[];
  extensions?: {
    code?: string;
    [key: string]: unknown;
  };
}

/**
 * GraphQL response structure
 */
export interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
}

/**
 * GraphQL mutation specification for a single transaction
 */
export interface GraphQLMutationSpec {
  /** GraphQL field invocation (e.g. taskUpdate(...){ syncId }) */
  mutation: string;
  /** Variables used by the mutation */
  variables?: Record<string, unknown>;
  /** GraphQL variable types */
  variableTypes?: Record<string, string>;
}

/**
 * Builds a GraphQL mutation for a transaction
 */
export type GraphQLMutationBuilder = (
  transaction: Transaction,
  index: number
) => GraphQLMutationSpec;
