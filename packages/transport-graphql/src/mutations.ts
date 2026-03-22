import type {
  MutateResult,
  SyncId,
  TransactionBatch,
  TransactionResult,
} from "@stratasync/core";
import { maxSyncId, ZERO_SYNC_ID } from "@stratasync/core";

import type {
  AuthProvider,
  GraphQLError,
  GraphQLMutationBuilder,
  GraphQLResponse,
  RetryConfig,
} from "./types.js";
import {
  buildRequestHeaders,
  fetchChecked,
  isRetryableError,
  parseSyncId,
  resolveAuthToken,
  retryWithBackoff,
} from "./utils.js";

/**
 * Maps internal action codes to GraphQL action names
 */
const mapActionToGraphQL = (action: string): string => {
  const mapping: Record<string, string> = {
    A: "ARCHIVE",
    D: "DELETE",
    I: "INSERT",
    U: "UPDATE",
    V: "UNARCHIVE",
  };
  return mapping[action] ?? action;
};

interface RestMutateResponse {
  success: boolean;
  lastSyncId: string;
  results: {
    clientTxId: string;
    success: boolean;
    syncId?: string;
    error?: string;
  }[];
}

interface MutationPayload {
  aliasMap: Map<string, string>;
  query: string;
  variables: Record<string, unknown>;
}

const mergeInto = <V>(
  target: Record<string, V>,
  source: Record<string, V> | undefined,
  label: string
): void => {
  if (!source) {
    return;
  }

  for (const [key, value] of Object.entries(source)) {
    if (key in target) {
      throw new Error(`Duplicate GraphQL ${label}: ${key}`);
    }
    target[key] = value;
  }
};

const buildMutationPayload = (
  batch: TransactionBatch,
  mutationBuilder: GraphQLMutationBuilder
): MutationPayload => {
  const mutationSpecs = batch.transactions.map((tx, index) =>
    mutationBuilder(tx, index)
  );

  const aliasMap = new Map<string, string>();
  const fields: string[] = [];
  const variables: Record<string, unknown> = {};
  const variableTypes: Record<string, string> = {};

  for (const [index, spec] of mutationSpecs.entries()) {
    const alias = `t${index}`;
    const tx = batch.transactions[index];
    if (!tx) {
      continue;
    }
    aliasMap.set(alias, tx.clientTxId);
    fields.push(`${alias}: ${spec.mutation}`);

    mergeInto(variables, spec.variables, "variable");
    mergeInto(variableTypes, spec.variableTypes, "variable type");
  }

  const variableDefs = Object.entries(variableTypes)
    .map(([key, type]) => `$${key}: ${type}`)
    .join(", ");
  const query = `mutation SyncBatch${variableDefs ? `(${variableDefs})` : ""} { ${fields.join(" ")} }`;

  return { aliasMap, query, variables };
};

const collectGraphQLErrors = (
  errors?: GraphQLError[]
): {
  errorsByAlias: Map<string, string[]>;
  unscopedErrors: string[];
} => {
  const errorsByAlias = new Map<string, string[]>();
  const unscopedErrors: string[] = [];

  if (!errors?.length) {
    return { errorsByAlias, unscopedErrors };
  }

  for (const error of errors) {
    const pathAlias = error.path?.[0];
    if (typeof pathAlias === "string") {
      const existing = errorsByAlias.get(pathAlias) ?? [];
      existing.push(error.message);
      errorsByAlias.set(pathAlias, existing);
    } else {
      unscopedErrors.push(error.message);
    }
  }

  return { errorsByAlias, unscopedErrors };
};

const parseMutationResults = (
  response: GraphQLResponse<Record<string, unknown>>,
  aliasMap: Map<string, string>
): MutateResult => {
  if (!response.data) {
    throw new Error("No data in mutation response");
  }

  const { errorsByAlias, unscopedErrors } = collectGraphQLErrors(
    response.errors
  );

  if (unscopedErrors.length > 0) {
    throw new Error(`GraphQL errors: ${unscopedErrors.join(", ")}`);
  }

  const results: TransactionResult[] = [];
  let lastSyncId: SyncId = ZERO_SYNC_ID;
  let success = true;

  for (const [alias, clientTxId] of aliasMap.entries()) {
    const aliasErrors = errorsByAlias.get(alias);
    if (aliasErrors) {
      results.push({
        clientTxId,
        error: aliasErrors.join(", "),
        success: false,
      });
      success = false;
      continue;
    }

    const payload = response.data[alias];
    if (!payload || typeof payload !== "object") {
      results.push({
        clientTxId,
        error: "Missing mutation response",
        success: false,
      });
      success = false;
      continue;
    }

    const payloadRecord = payload as Record<string, unknown>;
    if (payloadRecord.success === false) {
      results.push({
        clientTxId,
        error:
          typeof payloadRecord.error === "string"
            ? payloadRecord.error
            : "Mutation failed",
        success: false,
      });
      success = false;
      continue;
    }

    const syncIdRaw = payloadRecord.syncId;
    const syncId: SyncId | undefined =
      syncIdRaw === undefined
        ? undefined
        : parseSyncId(syncIdRaw, `Mutation response ${alias} syncId`);

    if (syncId !== undefined) {
      lastSyncId = maxSyncId(lastSyncId, syncId);
    }

    results.push({
      clientTxId,
      success: true,
      ...(syncId !== undefined && { syncId }),
    });
  }

  return {
    lastSyncId,
    results,
    success,
  };
};

export interface SendRestMutationsOptions {
  endpoint: string;
  batch: TransactionBatch;
  auth: AuthProvider;
  headers?: Record<string, string>;
  retryConfig?: RetryConfig;
  timeoutMs?: number;
}

/**
 * Sends mutations via REST endpoint (no GraphQL)
 * Used when no mutationBuilder is configured
 */
export const sendRestMutations = async (
  opts: SendRestMutationsOptions
): Promise<MutateResult> => {
  if (opts.batch.transactions.length === 0) {
    return {
      lastSyncId: ZERO_SYNC_ID,
      results: [],
      success: true,
    };
  }

  const response = await retryWithBackoff(
    async () => {
      const token = await resolveAuthToken(opts.auth);
      const requestHeaders = buildRequestHeaders({
        contentType: "application/json",
        headers: opts.headers,
        token,
      });
      const body = JSON.stringify({
        batchId: opts.batch.batchId,
        transactions: opts.batch.transactions.map((tx) => ({
          action: mapActionToGraphQL(tx.action),
          clientId: tx.clientId,
          clientTxId: tx.clientTxId,
          modelId: tx.modelId,
          modelName: tx.modelName,
          payload:
            tx.action === "D" && tx.original
              ? { ...tx.original, ...tx.payload }
              : tx.payload,
        })),
      });

      const res = await fetchChecked(
        opts.endpoint,
        { body, headers: requestHeaders, method: "POST" },
        opts.timeoutMs,
        "Mutation failed"
      );

      return res.json() as Promise<RestMutateResponse>;
    },
    opts.retryConfig,
    isRetryableError
  );

  return {
    lastSyncId: parseSyncId(
      response.lastSyncId,
      "Mutation response lastSyncId"
    ),
    results: response.results.map((r) => {
      const result: TransactionResult = {
        clientTxId: r.clientTxId,
        success: r.success,
      };
      if (r.syncId !== undefined) {
        result.syncId = parseSyncId(
          r.syncId,
          `Mutation response result ${r.clientTxId} syncId`
        );
      }
      if (r.error !== undefined) {
        result.error = r.error;
      }
      return result;
    }),
    success: response.success,
  };
};

export interface SendMutationsOptions {
  endpoint: string;
  batch: TransactionBatch;
  auth: AuthProvider;
  headers?: Record<string, string>;
  retryConfig?: RetryConfig;
  timeoutMs?: number;
  mutationBuilder: GraphQLMutationBuilder;
}

/**
 * Sends a batch of mutations to the server via GraphQL
 */
export const sendMutations = async (
  opts: SendMutationsOptions
): Promise<MutateResult> => {
  if (opts.batch.transactions.length === 0) {
    return {
      lastSyncId: ZERO_SYNC_ID,
      results: [],
      success: true,
    };
  }

  const { aliasMap, query, variables } = buildMutationPayload(
    opts.batch,
    opts.mutationBuilder
  );

  const response = await retryWithBackoff(
    async () => {
      const token = await resolveAuthToken(opts.auth);
      const requestHeaders = buildRequestHeaders({
        contentType: "application/json",
        headers: opts.headers,
        token,
      });
      const body = JSON.stringify({
        query,
        variables,
      });

      const res = await fetchChecked(
        opts.endpoint,
        { body, headers: requestHeaders, method: "POST" },
        opts.timeoutMs,
        "Mutation failed"
      );

      return res.json() as Promise<GraphQLResponse<Record<string, unknown>>>;
    },
    opts.retryConfig,
    isRetryableError
  );

  return parseMutationResults(response, aliasMap);
};

/**
 * Checks if an error indicates auth failure
 */
export const isAuthError = (error: unknown): boolean => {
  if (error instanceof Error) {
    return (
      error.message.includes("401") ||
      error.message.includes("403") ||
      error.message.includes("Unauthorized") ||
      error.message.includes("Forbidden")
    );
  }
  return false;
};
