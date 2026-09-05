import type {
  SyncAccessDecision,
  SyncAccessOperation,
  SyncAuthConfig,
  SyncLogger,
} from "../config.js";
import { noopLogger } from "../config.js";
import type { SyncDao } from "../dao/sync-dao.js";
import type { SyncUserContext } from "../types.js";
import { dedupeSyncGroups } from "../utils/sync-scope.js";

/**
 * Verifies a token, swallowing verification errors into `null`.
 *
 * `expired` is true when the underlying auth layer threw an error whose message
 * mentions expiry — the HTTP channel uses this to return a distinct
 * "Token expired" response, while the WS channel ignores it.
 */
export interface TokenVerification {
  payload: Awaited<ReturnType<SyncAuthConfig["verifyToken"]>>;
  expired: boolean;
}

export const verifyTokenOrNull = async (
  auth: SyncAuthConfig,
  token: string
): Promise<TokenVerification> => {
  try {
    const payload = await auth.verifyToken(token);
    return { expired: false, payload };
  } catch (error) {
    const expired = error instanceof Error && error.message.includes("expired");
    return { expired, payload: null };
  }
};

/**
 * Discriminated result of authorizing a token + resolving its sync groups.
 *
 * - `authorized`: token valid and groups resolved, then narrowed by policy.
 * - `invalid_token`: token missing/invalid (optionally expired).
 * - `group_failure`: token valid but group resolution threw.
 * - `access_denied`: application policy rejected the operation.
 * - `policy_failure`: application policy threw while deciding access.
 */
export type AuthResult =
  | {
      status: "authorized";
      user: SyncUserContext;
    }
  | {
      status: "invalid_token";
      expired: boolean;
    }
  | {
      status: "group_failure";
      error: unknown;
    }
  | {
      status: "access_denied";
    }
  | {
      status: "policy_failure";
      error: unknown;
    };

/**
 * Authorizes a token end-to-end: verify, then resolve groups from auth and the
 * DAO in parallel, then dedupe (resolved + db + userId) before applying access
 * policy. Both the HTTP
 * middleware and the WS subscribe path call this and map the discriminated
 * result to their existing byte-identical responses.
 */
export const authorizeToken = async (
  auth: SyncAuthConfig,
  syncDao: SyncDao,
  token: string,
  logger: SyncLogger = noopLogger,
  operation: SyncAccessOperation = "read"
): Promise<AuthResult> => {
  const { expired, payload } = await verifyTokenOrNull(auth, token);

  if (!payload) {
    return { expired, status: "invalid_token" };
  }

  const { userId } = payload;

  try {
    const [resolvedGroups, dbGroups] = await Promise.all([
      auth.resolveGroups(userId),
      syncDao.getUserGroups(userId),
    ]);

    const resolved = dedupeSyncGroups([...resolvedGroups, ...dbGroups, userId]);
    let groups = resolved;

    if (auth.authorizeAccess) {
      let decision: SyncAccessDecision | false;
      try {
        decision = await auth.authorizeAccess({
          groups: resolved,
          operation,
          principal: payload.principal,
          user: payload,
        });
      } catch (error) {
        logger.error({ error, operation, userId }, "Sync access policy failed");
        return { error, status: "policy_failure" };
      }

      if (!decision) {
        return { status: "access_denied" };
      }

      const allowed = new Set(decision.allowedGroups);
      groups = resolved.filter((group) => allowed.has(group));
    } else if (payload.principal !== undefined) {
      logger.warn(
        { operation, userId },
        "Sync principal rejected because no access policy is configured"
      );
      return { status: "access_denied" };
    }

    return {
      status: "authorized",
      user: {
        email: payload.email,
        groups,
        name: payload.name,
        ...(payload.principal === undefined
          ? {}
          : { principal: payload.principal }),
        userId,
      },
    };
  } catch (error) {
    logger.error({ error }, "Sync group resolution failed");
    return { error, status: "group_failure" };
  }
};
