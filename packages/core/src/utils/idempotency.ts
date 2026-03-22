/**
 * Generates a UUID v4
 * Uses crypto.randomUUID when available, falls back to manual generation
 */
export const generateUUID = (): string => {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto;
  if (cryptoRef?.randomUUID) {
    return cryptoRef.randomUUID();
  }

  // Fallback implementation
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replaceAll(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === "x" ? r : (r % 4) + 8;
    return v.toString(16);
  });
};

/**
 * Generates a unique client ID for this browser/device instance
 * Persisted in localStorage to maintain consistency across sessions
 */
export const getOrCreateClientId = (storageKey = "sync_client_id"): string => {
  interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  }

  const storage = (globalThis as { localStorage?: StorageLike }).localStorage;
  if (!storage) {
    return generateUUID();
  }

  let clientId = storage.getItem(storageKey);

  if (!clientId) {
    clientId = generateUUID();
    storage.setItem(storageKey, clientId);
  }

  return clientId;
};

/**
 * Generates a unique transaction ID
 * Uses UUID v4 format for guaranteed uniqueness
 */
export const generateClientTxId = (): string => generateUUID();
