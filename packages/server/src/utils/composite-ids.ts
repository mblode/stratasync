import { v5 as uuidv5 } from "uuid";

/**
 * Default namespace for composite sync IDs.
 * Keep this stable. Changing it will regenerate all composite IDs.
 */
export const DEFAULT_COMPOSITE_ID_NAMESPACE =
  "92a73695-d772-4b43-9fb4-d79f5fbef300";

/**
 * Creates a deterministic composite sync ID using UUIDv5.
 *
 * @param model - The model name (e.g., "TaskLabel")
 * @param parts - The composite key parts in stable order
 * @param namespace - UUID namespace (defaults to the built-in sync namespace)
 */
export const createCompositeSyncId = (
  model: string,
  parts: readonly string[],
  namespace: string = DEFAULT_COMPOSITE_ID_NAMESPACE
): string => uuidv5(`${model}:${JSON.stringify(parts)}`, namespace);
