"use client";

import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import type * as React from "react";

import { cn } from "@/lib/utils";

const ScrollBar = ({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Scrollbar>) => (
  <ScrollAreaPrimitive.Scrollbar
    className={cn(
      "flex touch-none select-none p-px transition-colors",
      orientation === "vertical" &&
        "h-full w-2.5 border-l border-l-transparent",
      orientation === "horizontal" &&
        "h-2.5 flex-col border-t border-t-transparent",
      className
    )}
    data-slot="scroll-area-scrollbar"
    orientation={orientation}
    {...props}
  >
    <ScrollAreaPrimitive.Thumb
      className="relative flex-1 rounded-full bg-border"
      data-slot="scroll-area-thumb"
    />
  </ScrollAreaPrimitive.Scrollbar>
);

const ScrollArea = ({
  className,
  children,
  viewportRef,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  viewportRef?: React.Ref<HTMLDivElement>;
}) => (
  <ScrollAreaPrimitive.Root
    className={cn("relative flex flex-col", className)}
    data-slot="scroll-area"
    {...props}
  >
    <ScrollAreaPrimitive.Viewport
      className="w-full min-h-0 flex-1 rounded-[inherit] outline-none transition-[color,box-shadow] focus-visible:outline-1 focus-visible:ring-[3px] focus-visible:ring-ring/50"
      data-slot="scroll-area-viewport"
      ref={viewportRef}
    >
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
);

export { ScrollArea, ScrollBar };
