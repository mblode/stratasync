import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ZodType } from "zod";

import type { SyncAuthConfig, SyncLogger } from "../config.js";
import { noopLogger } from "../config.js";
import type { SyncDao } from "../dao/sync-dao.js";
import type { SyncUserContext } from "../types.js";

export interface SyncAuthenticatedRequest extends FastifyRequest {
  syncUser: SyncUserContext;
}

type SyncAuthMiddleware = (
  request: FastifyRequest,
  reply: FastifyReply
) => Promise<void>;

const extractBearerToken = (authHeader: string | null): string | null => {
  if (!authHeader) {
    return null;
  }
  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") {
    return null;
  }
  return parts[1]?.trim() ?? null;
};

export const createSyncAuthMiddleware = (
  auth: SyncAuthConfig,
  syncDao: SyncDao,
  logger: SyncLogger = noopLogger
): SyncAuthMiddleware =>
  async function syncAuthMiddleware(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    logger.debug({ url: request.url }, "Sync auth middleware started");

    const authHeader = request.headers.authorization ?? null;

    if (!authHeader) {
      logger.debug({ url: request.url }, "Sync auth rejected: no auth header");
      reply.code(401).send({ error: "Authorization header required" });
      return;
    }

    const token = extractBearerToken(authHeader);

    if (!token) {
      logger.debug({ url: request.url }, "Sync auth rejected: invalid format");
      reply.code(401).send({ error: "Invalid authorization format" });
      return;
    }

    let authPayload;
    try {
      authPayload = await auth.verifyToken(token);
    } catch (error) {
      logger.warn({ error }, "Sync auth failed");

      if (error instanceof Error && error.message.includes("expired")) {
        reply.code(401).send({ error: "Token expired" });
        return;
      }

      reply.code(401).send({ error: "Invalid token" });
      return;
    }

    if (!authPayload) {
      reply.code(401).send({ error: "Invalid token" });
      return;
    }

    try {
      const { userId } = authPayload;
      const [groupsFromAuth, groupsFromDb] = await Promise.all([
        auth.resolveGroups(userId),
        syncDao.getUserGroups(userId),
      ]);
      const groups = [...new Set([...groupsFromAuth, ...groupsFromDb, userId])];

      const syncUser: SyncUserContext = {
        email: authPayload.email,
        groups,
        name: authPayload.name,
        userId,
      };

      (request as SyncAuthenticatedRequest).syncUser = syncUser;
      logger.debug(
        { userId: syncUser.userId },
        "Sync auth middleware complete"
      );
    } catch (error) {
      logger.error({ error }, "Sync group resolution failed");
      reply.code(500).send({ error: "Failed to resolve sync groups" });
    }
  };

export const getSyncUser = (request: FastifyRequest): SyncUserContext => {
  const syncRequest = request as SyncAuthenticatedRequest;
  if (!syncRequest.syncUser) {
    throw new Error("Sync user context not found");
  }
  return syncRequest.syncUser;
};

// ---------------------------------------------------------------------------
// Validation middleware
// ---------------------------------------------------------------------------

interface ValidationError {
  field: string;
  message: string;
}

const formatZodError = (error: z.ZodError): ValidationError[] => {
  const flattened = z.flattenError(error);
  const errors: ValidationError[] = [];

  for (const message of flattened.formErrors) {
    errors.push({ field: "root", message });
  }

  const fieldErrors = flattened.fieldErrors as Record<
    string,
    string[] | undefined
  >;
  for (const [field, messages] of Object.entries(fieldErrors)) {
    if (Array.isArray(messages)) {
      for (const message of messages) {
        errors.push({ field, message });
      }
    }
  }

  return errors;
};

const sendValidationError = (
  request: FastifyRequest,
  reply: FastifyReply,
  errors: ValidationError[],
  source: string
): void => {
  reply.code(400).send({
    details: errors,
    error: "Validation failed",
    requestId: request.id,
    source,
  });
};

type PreHandlerHook = (
  request: FastifyRequest,
  reply: FastifyReply,
  done: (err?: Error) => void
) => void;

export const validateBody =
  <T>(schema: ZodType<T>): PreHandlerHook =>
  (request: FastifyRequest, reply: FastifyReply, done) => {
    const result = schema.safeParse(request.body);
    if (!result.success) {
      sendValidationError(request, reply, formatZodError(result.error), "body");
      return;
    }
    done();
  };

export const validateQuery =
  <T>(schema: ZodType<T>): PreHandlerHook =>
  (request: FastifyRequest, reply: FastifyReply, done) => {
    const result = schema.safeParse(request.query);
    if (!result.success) {
      sendValidationError(
        request,
        reply,
        formatZodError(result.error),
        "query"
      );
      return;
    }
    done();
  };
