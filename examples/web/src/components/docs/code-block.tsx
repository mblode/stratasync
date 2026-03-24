import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.js";

const CodeBlock = ({
  children,
  className,
  ...props
}: ComponentProps<"pre">) => (
  <pre
    className={cn(
      "overflow-x-auto rounded-lg bg-primary px-4 py-3 text-sm text-primary-foreground",
      className
    )}
    {...props}
  >
    <code>{children}</code>
  </pre>
);

export { CodeBlock };
