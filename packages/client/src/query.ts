import type { IdentityMap } from "./identity-map.js";
import type { QueryOptions, QueryResult } from "./types.js";

/**
 * Executes a query against an identity map
 */
export const executeQuery = <T extends Record<string, unknown>>(
  map: IdentityMap<T>,
  options: QueryOptions<T> = {}
): QueryResult<T> => {
  let results = map.values();

  // Filter by predicate
  if (options.where) {
    results = results.filter(options.where);
  }

  // Filter archived unless explicitly included
  if (!options.includeArchived) {
    results = results.filter((item) => !item.archivedAt);
  }

  // Get total count before pagination
  const totalCount = results.length;

  // Sort results
  if (options.orderBy) {
    results = results.toSorted(options.orderBy);
  }

  // Apply offset
  if (options.offset && options.offset > 0) {
    results = results.slice(options.offset);
  }

  // Apply limit
  let hasMore = false;
  if (options.limit && options.limit > 0) {
    hasMore = results.length > options.limit;
    results = results.slice(0, options.limit);
  }

  return {
    data: results,
    hasMore,
    totalCount,
  };
};
