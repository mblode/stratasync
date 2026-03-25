/**
 * Zod validation schemas for sync API endpoints
 */

import { z } from "zod";

/**
 * GET /sync/bootstrap - Bootstrap query params
 */
export const BootstrapQuerySchema = z
  .object({
    firstSyncId: z
      .string()
      .regex(/^\d+$/, "firstSyncId must be a numeric string")
      .optional(),
    noSyncPackets: z.enum(["true", "false"]).optional(),
    onlyModels: z.string().optional(),
    schemaHash: z.string().optional(),
    syncGroups: z.string().optional(),
    type: z.enum(["full", "partial"]).optional(),
  })
  .superRefine((query, ctx) => {
    if (query.type === "partial" && !query.firstSyncId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "firstSyncId is required for partial bootstrap",
        path: ["firstSyncId"],
      });
    }
  });

export type BootstrapQuery = z.infer<typeof BootstrapQuerySchema>;

/**
 * Individual batch request -- either indexed (by key/value) or group-based
 */
const BatchRequestIndexedSchema = z.object({
  indexedKey: z.string().min(1),
  keyValue: z.string().min(1),
  modelName: z.string().min(1, "Model name is required"),
});

const BatchRequestGroupSchema = z.object({
  groupId: z.string().min(1, "Group ID is required"),
  modelName: z.string().min(1, "Model name is required"),
});

const BatchRequestSchema = z.union([
  BatchRequestIndexedSchema,
  BatchRequestGroupSchema,
]);

const MAX_BATCH_REQUESTS = 100;

/**
 * POST /sync/batch - Batch load request body
 */
export const BatchLoadBodySchema = z.object({
  firstSyncId: z
    .string()
    .regex(/^\d+$/, "firstSyncId must be a numeric string")
    .optional(),
  requests: z
    .array(BatchRequestSchema)
    .min(1, "At least one request is required")
    .max(
      MAX_BATCH_REQUESTS,
      `At most ${MAX_BATCH_REQUESTS} requests are allowed`
    ),
});

export type BatchLoadBody = z.infer<typeof BatchLoadBodySchema>;

/**
 * GET /sync/deltas - Delta query params
 */
export const DeltaQuerySchema = z.object({
  after: z.string().regex(/^\d+$/, "After must be a numeric string").optional(),
  limit: z.string().regex(/^\d+$/, "Limit must be a numeric string").optional(),
  syncGroups: z.string().optional(),
});

export type DeltaQuery = z.infer<typeof DeltaQuerySchema>;

/**
 * Transaction action enum
 */
const TransactionActionSchema = z.enum([
  "INSERT",
  "UPDATE",
  "DELETE",
  "ARCHIVE",
  "UNARCHIVE",
]);

/**
 * Individual transaction in a mutate request
 */
const TransactionSchema = z.object({
  action: TransactionActionSchema,
  clientId: z.string().min(1, "Client ID is required"),
  clientTxId: z.string().min(1, "Client transaction ID is required"),
  modelId: z.string().min(1, "Model ID is required"),
  modelName: z.string().min(1, "Model name is required"),
  payload: z.record(z.string(), z.unknown()),
});

const MAX_MUTATE_TRANSACTIONS = 100;

/**
 * POST /sync/mutate - Mutate request body
 */
export const MutateBodySchema = z.object({
  batchId: z.string().min(1, "Batch ID is required"),
  transactions: z
    .array(TransactionSchema)
    .min(1, "At least one transaction is required")
    .max(
      MAX_MUTATE_TRANSACTIONS,
      `At most ${MAX_MUTATE_TRANSACTIONS} transactions are allowed`
    ),
});

export type MutateBody = z.infer<typeof MutateBodySchema>;
