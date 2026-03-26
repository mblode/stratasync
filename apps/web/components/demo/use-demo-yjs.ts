/* eslint-disable eslint-plugin-promise/prefer-await-to-then, eslint-plugin-promise/prefer-catch, no-empty-function */
"use client";

import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";

// ---------------------------------------------------------------------------
// Module-level Y.Doc relay — shared between the two DocsPanel instances
// ---------------------------------------------------------------------------

interface Relay {
  docA: Y.Doc;
  docB: Y.Doc;
  onlineA: boolean;
  onlineB: boolean;
  refCount: number;
  destroy: () => void;
}

let activeRelay: Relay | null = null;

const syncDocs = (relay: Relay): void => {
  const svA = Y.encodeStateVector(relay.docA);
  const svB = Y.encodeStateVector(relay.docB);
  const updateForB = Y.encodeStateAsUpdate(relay.docA, svB);
  const updateForA = Y.encodeStateAsUpdate(relay.docB, svA);
  Y.applyUpdate(relay.docA, updateForA, "remote");
  Y.applyUpdate(relay.docB, updateForB, "remote");
};

const createRelay = (): Relay => {
  const docA = new Y.Doc();
  const docB = new Y.Doc();

  const relay: Relay = {
    destroy: () => {
      docA.destroy();
      docB.destroy();
    },
    docA,
    docB,
    onlineA: true,
    onlineB: true,
    refCount: 0,
  };

  // Relay updates from A → B (when both online)
  docA.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "remote" && relay.onlineA && relay.onlineB) {
      Y.applyUpdate(docB, update, "remote");
    }
  });

  // Relay updates from B → A (when both online)
  docB.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "remote" && relay.onlineA && relay.onlineB) {
      Y.applyUpdate(docA, update, "remote");
    }
  });

  return relay;
};

const getOrCreateRelay = (): Relay => {
  if (!activeRelay) {
    activeRelay = createRelay();
  }
  activeRelay.refCount += 1;
  return activeRelay;
};

const releaseRelay = (): void => {
  if (!activeRelay) {
    return;
  }
  activeRelay.refCount -= 1;
  if (activeRelay.refCount <= 0) {
    activeRelay.destroy();
    activeRelay = null;
  }
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface DemoYjsRelay {
  doc: Y.Doc;
  setOnline: (online: boolean) => void;
}

export const useDemoYjsRelay = (label: string): DemoYjsRelay | null => {
  const [relay, setRelay] = useState<Relay | null>(null);
  const relayRef = useRef<Relay | null>(null);
  const isDeviceA = label === "Device A";

  useEffect(() => {
    const r = getOrCreateRelay();
    relayRef.current = r;
    setRelay(r);

    return () => {
      relayRef.current = null;
      releaseRelay();
    };
  }, []);

  if (!relay) {
    return null;
  }

  const doc = isDeviceA ? relay.docA : relay.docB;

  const setOnline = (online: boolean) => {
    const r = relayRef.current;
    if (!r) {
      return;
    }

    if (isDeviceA) {
      r.onlineA = online;
    } else {
      r.onlineB = online;
    }

    // When coming back online, exchange state vectors to sync missed updates
    if (online && r.onlineA && r.onlineB) {
      syncDocs(r);
    }
  };

  return { doc, setOnline };
};
