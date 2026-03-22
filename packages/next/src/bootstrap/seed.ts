// oxlint-disable no-use-before-define -- helper functions are grouped after exported functions for readability
import {
  computeSchemaHash,
  getOrCreateClientId,
  ModelRegistry,
} from "@stratasync/core";

import { deserializeBootstrapSnapshot } from "./serialize.js";
import type {
  BootstrapSnapshot,
  BootstrapSnapshotPayload,
  SeedStorageOptions,
  SeedStorageResult,
} from "./types.js";

export const seedStorageFromBootstrap = async (
  options: SeedStorageOptions
): Promise<SeedStorageResult> => {
  const {
    storage,
    snapshot,
    dbName = "sync-db",
    clearExisting = true,
    validateSchemaHash = true,
    batchSize = 500,
    closeAfter = true,
    schema,
  } = options;

  const resolvedSnapshot = await resolveSnapshot(snapshot);
  const localSchemaHash = computeSchemaHash(schema ?? ModelRegistry.snapshot());

  if (
    validateSchemaHash &&
    resolvedSnapshot.schemaHash &&
    resolvedSnapshot.schemaHash !== localSchemaHash
  ) {
    return { applied: false, reason: "schema_mismatch", rowCount: 0 };
  }

  let opened = false;

  try {
    await storage.open({ name: dbName, schema });
    opened = true;

    const existingMeta = await storage.getMeta();
    const clientId =
      existingMeta.clientId || getOrCreateClientId(`${dbName}_client_id`);

    if (clearExisting) {
      await storage.clear();
    }

    let ops: {
      type: "put";
      modelName: string;
      data: Record<string, unknown>;
    }[] = [];

    for (const row of resolvedSnapshot.rows) {
      ops.push({ data: row.data, modelName: row.modelName, type: "put" });

      if (ops.length >= batchSize) {
        await storage.writeBatch(ops);
        ops = [];
      }
    }

    if (ops.length > 0) {
      await storage.writeBatch(ops);
    }

    await storage.setMeta({
      bootstrapComplete: true,
      clientId,
      firstSyncId: resolvedSnapshot.firstSyncId,
      lastSyncAt: resolvedSnapshot.fetchedAt,
      lastSyncId: resolvedSnapshot.lastSyncId,
      schemaHash: localSchemaHash,
      subscribedSyncGroups: resolvedSnapshot.groups,
    });

    return { applied: true, rowCount: resolvedSnapshot.rows.length };
  } finally {
    if (closeAfter && opened) {
      await storage.close();
    }
  }
};

const isPayload = (
  value: BootstrapSnapshot | BootstrapSnapshotPayload | string
): value is BootstrapSnapshotPayload =>
  typeof value === "object" && value !== null && "encoding" in value;

const resolveSnapshot = (
  snapshot: BootstrapSnapshot | BootstrapSnapshotPayload | string
): Promise<BootstrapSnapshot> => {
  if (typeof snapshot === "string") {
    const parsed = JSON.parse(snapshot) as BootstrapSnapshotPayload;
    return deserializeBootstrapSnapshot(parsed);
  }

  if (isPayload(snapshot)) {
    return deserializeBootstrapSnapshot(snapshot);
  }

  return Promise.resolve(snapshot);
};
