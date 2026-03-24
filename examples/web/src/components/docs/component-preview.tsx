import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.js";

const ComponentPreview = ({
  children,
  className,
  description,
  ...props
}: ComponentProps<"div"> & {
  description?: string;
}) => (
  <div
    className={cn(
      "not-prose flex min-h-[150px] items-center justify-center rounded-lg border border-border p-8",
      className
    )}
    {...props}
  >
    <div className="flex flex-col items-center gap-4">
      {children}
      {description ? (
        <p className="text-xs text-muted-foreground">{description}</p>
      ) : null}
    </div>
  </div>
);

export { ComponentPreview };
