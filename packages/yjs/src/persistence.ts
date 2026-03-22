const DEFAULT_SCOPE = "default";

export const DEFAULT_PERSISTED_YJS_PREFIX = "done:yjs:";

export const createPersistedYjsPrefix = (scope: string): string => {
  const normalizedScope = scope.trim() || DEFAULT_SCOPE;
  return `${DEFAULT_PERSISTED_YJS_PREFIX}${normalizedScope}:`;
};

export const clearPersistedYjsDocuments = (
  prefix: string = DEFAULT_PERSISTED_YJS_PREFIX
): void => {
  if (typeof localStorage === "undefined") {
    return;
  }

  const keysToRemove: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (typeof key === "string" && key.startsWith(prefix)) {
      keysToRemove.push(key);
    }
  }

  for (const key of keysToRemove) {
    localStorage.removeItem(key);
  }
};
