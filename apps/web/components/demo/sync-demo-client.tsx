"use client";

import dynamic from "next/dynamic";

const SyncDemo = dynamic(
  async () => {
    const m = await import("./sync-demo");
    return m.SyncDemo;
  },
  { ssr: false }
);

export const SyncDemoClient = () => <SyncDemo />;
