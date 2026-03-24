import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.js";

const Steps = ({ children, className, ...props }: ComponentProps<"div">) => (
  <div
    className={cn(
      "[counter-reset:step] [&>h3]:step [&>h3]:before:absolute [&>h3]:before:-left-9 [&>h3]:before:inline-flex [&>h3]:before:size-7 [&>h3]:before:items-center [&>h3]:before:justify-center [&>h3]:before:rounded-full [&>h3]:before:border [&>h3]:before:border-border [&>h3]:before:bg-secondary [&>h3]:before:text-center [&>h3]:before:text-xs [&>h3]:before:font-medium [&>h3]:before:text-secondary-foreground [&>h3]:before:[content:counter(step)] [&>h3]:before:[counter-increment:step] ml-9 border-l border-border pl-9 [&>h3]:relative [&>h3]:mb-3 [&>h3]:mt-8 [&>h3]:text-base [&>h3]:font-semibold [&>h3]:first:mt-0",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export { Steps };
