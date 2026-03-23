import type { ModelMetadata } from "@stratasync/core";
import { ModelRegistry } from "@stratasync/core";

const HASH_MODULUS = 2 ** 32;

const simpleHash = (input: string): number => {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    const char = input.codePointAt(i) ?? 0;
    hash = (hash * 33 + char) % HASH_MODULUS;
  }
  return hash;
};

const toHex = (num: number): string => num.toString(16).padStart(8, "0");

const hash32 = (input: string): string => {
  const parts = [0, 1, 2, 3].map((suffix) =>
    toHex(simpleHash(`${input}:${suffix}`))
  );
  return parts.join("");
};

interface RegistryLike {
  getPropertyNames(modelName: string): string[];
  getModelMetadata(modelName: string): ModelMetadata | undefined;
  getPrimaryKey?(modelName: string): string;
}

const getPropertyNames = (
  modelName: string,
  registry: RegistryLike
): string[] => {
  const names = new Set<string>(registry.getPropertyNames(modelName));
  const primaryKey = registry.getPrimaryKey?.(modelName) ?? "id";
  names.add(primaryKey);
  return [...names].toSorted();
};

export const computeModelStoreName = (
  modelName: string,
  schemaVersion: number,
  registry: RegistryLike = ModelRegistry
): string => {
  const meta = registry.getModelMetadata(modelName);
  const payload = {
    name: modelName,
    partial: meta?.loadStrategy === "partial" || undefined,
    partialLoadMode: meta?.partialLoadMode,
    properties: getPropertyNames(modelName, registry),
    schemaVersion,
  };

  return hash32(JSON.stringify(payload));
};

export const computeWorkspaceDatabaseName = (params: {
  userId: string;
  version: number;
  userVersion: number;
}): string => {
  const { userId, version, userVersion } = params;
  return `ss_${hash32(`${userId}:${version}:${userVersion}`)}`;
};

export const computePartialDatabaseName = (params: {
  storeName: string;
  workspaceDatabaseName: string;
}): string => {
  const { storeName, workspaceDatabaseName } = params;
  return `${workspaceDatabaseName}_${storeName}_partial`;
};
