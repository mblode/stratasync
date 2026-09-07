import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { BoxLabel } from "./box-label";

/**
 * A device: the reader's phone, or the other one. Plain on purpose — green
 * belongs to the server, which is the only authority on this page.
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
  <div className={cn("flex flex-col", className)}>
    <BoxLabel
      label={label}
      status={status}
      tone={offline ? "pending" : undefined}
    />
    <div className="flex-1 rounded-xl bg-surface p-3">{children}</div>
  </div>
);
