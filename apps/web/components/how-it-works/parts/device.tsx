import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A device: the reader's phone, or the other one. Plain chrome on purpose —
 * green belongs to the server, which is the only authority on this page.
 */
export const Device = ({
  children,
  className,
  label,
  offline = false,
  status,
}: {
  children: ReactNode;
  className?: string;
  label: string;
  offline?: boolean;
  /** Short right-aligned state, e.g. a cursor position. */
  status?: ReactNode;
}) => (
  <div
    className={cn(
      "flex flex-col overflow-hidden rounded-lg border bg-background",
      offline ? "border-warning/50" : "border-border",
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
