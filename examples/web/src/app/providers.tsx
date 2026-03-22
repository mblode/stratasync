"use client";

import { NextSyncProvider } from "@stratasync/next/client";
import type { ReactNode } from "react";

import { getSyncClient } from "@/lib/sync/create-client";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <NextSyncProvider
      client={getSyncClient}
      loading={<div className="loading-shell">Starting sync engine...</div>}
    >
      {children}
    </NextSyncProvider>
  );
}
