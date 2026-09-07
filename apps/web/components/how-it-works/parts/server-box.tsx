import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The server. The only green chrome on the page, and the 2px top edge is the
 * claim: this is the thing that decides.
 */
export const ServerBox = ({
  children,
  className,
  label = "Server",
  status,
}: {
  children: ReactNode;
  className?: string;
  label?: string;
  status?: ReactNode;
}) => (
  <div
    className={cn(
      "flex flex-col overflow-hidden rounded-lg border border-border border-t-2 border-t-primary bg-background",
      className
    )}
  >
    <div className="flex items-baseline justify-between gap-2 border-border border-b bg-surface px-3 py-1.5">
      <span className="font-sans font-medium text-xs">{label}</span>
      {status ? (
        <span className="font-mono text-[0.6875rem] text-muted-foreground tabular-figures">
          {status}
        </span>
      ) : null}
    </div>
    <div className="flex-1 p-3">{children}</div>
  </div>
);
