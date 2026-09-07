import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { BoxLabel } from "./box-label";

/**
 * The server. The faint green ground is the whole claim: this is the thing
 * that decides, and it is the only box on the page that gets a colour.
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
  <div className={cn("flex flex-col", className)}>
    <BoxLabel label={label} status={status} tone="synced" />
    <div className="flex-1 rounded-xl bg-primary/[0.07] p-3">{children}</div>
  </div>
);
