import { SyncProvider } from "@stratasync/react";
import { useMemo } from "react";
import type { ReactNode } from "react";

import { getSyncClient } from "@/lib/sync/create-client.js";

export const Providers = ({ children }: { children: ReactNode }) => {
  const client = useMemo(() => getSyncClient(), []);

  return (
    <SyncProvider autoStart client={client}>
      {children}
    </SyncProvider>
  );
};
