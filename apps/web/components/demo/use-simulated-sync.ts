/* eslint-disable eslint-plugin-promise/prefer-await-to-then, eslint-plugin-promise/prefer-catch, no-empty-function */
"use client";

import { createSyncClient } from "@stratasync/client";
import type { SyncClient } from "@stratasync/client";
import type { SchemaDefinition } from "@stratasync/core";
import { createMobXReactivity } from "@stratasync/mobx";
import { useCallback, useEffect, useRef, useState } from "react";

import { DemoServer, DemoTransport } from "./demo-transport";
import { InMemoryStorage } from "./in-memory-storage";
import type { SyncAnimation } from "./types";

// ---------------------------------------------------------------------------
// Schema & seed data
// ---------------------------------------------------------------------------

const schema: SchemaDefinition = {
  models: {
    Todo: {
      fields: {
        completed: {},
        createdAt: {},
        id: {},
        title: {},
        updatedAt: {},
      },
      loadStrategy: "instant",
    },
  },
};

const SEED_ROWS = [
  {
    data: {
      completed: true,
      createdAt: 1,
      id: "seed-1",
      title: "Design new dashboard layout",
      updatedAt: 1,
    },
    modelName: "Todo",
  },
  {
    data: {
      completed: false,
      createdAt: 2,
      id: "seed-2",
      title: "Review pull request #42",
      updatedAt: 2,
    },
    modelName: "Todo",
  },
  {
    data: {
      completed: false,
      createdAt: 3,
      id: "seed-3",
      title: "Update API documentation",
      updatedAt: 3,
    },
    modelName: "Todo",
  },
];

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface DemoInfra {
  clientA: SyncClient;
  clientB: SyncClient;
  server: DemoServer;
  transportA: DemoTransport;
  transportB: DemoTransport;
}

export interface DemoClients {
  clientA: SyncClient;
  clientB: SyncClient;
  transportA: DemoTransport;
  transportB: DemoTransport;
  activeSyncAnimations: SyncAnimation[];
}

export const useDemoClients = (): DemoClients | null => {
  const [infra, setInfra] = useState<DemoInfra | null>(null);
  const [activeSyncAnimations, setActiveSyncAnimations] = useState<
    SyncAnimation[]
  >([]);
  const animationCounter = useRef(0);
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const scheduleTimeout = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      timers.current.delete(id);
      fn();
    }, ms);
    timers.current.add(id);
  }, []);

  // Create infrastructure on client only
  useEffect(() => {
    const server = new DemoServer(SEED_ROWS);
    const transportA = new DemoTransport(server, "A");
    const transportB = new DemoTransport(server, "B");
    const reactivity = createMobXReactivity();

    const clientA = createSyncClient({
      dbName: "demo-a",
      optimistic: true,
      reactivity,
      schema,
      storage: new InMemoryStorage(),
      transport: transportA,
    });

    const clientB = createSyncClient({
      dbName: "demo-b",
      optimistic: true,
      reactivity,
      schema,
      storage: new InMemoryStorage(),
      transport: transportB,
    });

    setInfra({ clientA, clientB, server, transportA, transportB });

    return () => {
      clientA.stop().then(undefined, () => {});
      clientB.stop().then(undefined, () => {});
      transportA.close().then(undefined, () => {});
      transportB.close().then(undefined, () => {});
    };
  }, []);

  // Wire up sync flow animations once infra is ready
  useEffect(() => {
    if (!infra) {
      return;
    }

    infra.server.onSyncFlow = (direction) => {
      animationCounter.current += 1;
      const animId = `sync-${animationCounter.current}`;
      setActiveSyncAnimations((prev) => [...prev, { direction, id: animId }]);
      scheduleTimeout(() => {
        setActiveSyncAnimations((prev) => prev.filter((a) => a.id !== animId));
      }, 600);
    };

    const currentTimers = timers.current;
    return () => {
      infra.server.onSyncFlow = null;
      for (const t of currentTimers) {
        clearTimeout(t);
      }
      currentTimers.clear();
    };
  }, [infra, scheduleTimeout]);

  if (!infra) {
    return null;
  }

  return { ...infra, activeSyncAnimations };
};
