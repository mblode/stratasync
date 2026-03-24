import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.js";

const Callout = ({ children, className, ...props }: ComponentProps<"div">) => (
  <div
    className={cn(
      "rounded-lg border border-border bg-secondary/50 px-4 py-3 text-sm text-secondary-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export { Callout };
