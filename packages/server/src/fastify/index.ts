export {
  createSyncAuthMiddleware,
  extractBearerToken,
  getSyncUser,
  validateBody,
  validateQuery,
} from "./middleware.js";
export type { SyncAuthenticatedRequest } from "./middleware.js";

export {
  createBatchLoadRouteHandler,
  createBootstrapRouteHandler,
  registerSyncRoutes,
} from "./routes.js";

export {
  BatchLoadBodySchema,
  BootstrapQuerySchema,
  DeltaQuerySchema,
  MutateBodySchema,
} from "./validation.js";
export type {
  BatchLoadBody,
  BootstrapQuery,
  DeltaQuery,
  MutateBody,
} from "./validation.js";

export { registerSyncWebsocket } from "../websocket/sync-websocket.js";
