"use client";

import { PreviewCard as HoverCardPrimitive } from "@base-ui/react/preview-card";
import * as React from "react";

import { cn } from "@/lib/utils";

const HoverCard = ({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>) => (
  <HoverCardPrimitive.Root data-slot="hover-card" {...props} />
);

const HoverCardTrigger = ({
  asChild = false,
  children,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Trigger> & {
  asChild?: boolean;
}) => {
  const render =
    asChild && React.isValidElement(children)
      ? (children as React.ReactElement)
      : undefined;

  return (
    <HoverCardPrimitive.Trigger
      data-slot="hover-card-trigger"
      render={render}
      {...props}
    >
      {asChild ? null : children}
    </HoverCardPrimitive.Trigger>
  );
};

const HoverCardContent = ({
  asChild = false,
  children,
  className,
  align = "center",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Popup> &
  Pick<
    React.ComponentProps<typeof HoverCardPrimitive.Positioner>,
    "align" | "alignOffset" | "side" | "sideOffset"
  > & {
    asChild?: boolean;
  }) => {
  const render =
    asChild && React.isValidElement(children)
      ? (children as React.ReactElement)
      : undefined;

  return (
    <HoverCardPrimitive.Portal data-slot="hover-card-portal">
      <HoverCardPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        className="isolate z-50"
        side={side}
        sideOffset={sideOffset}
      >
        <HoverCardPrimitive.Popup
          className={cn(
            "data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-72 origin-(--transform-origin) rounded-md bg-popover p-4 text-popover-foreground shadow-popover outline-hidden data-closed:animate-out data-open:animate-in",
            className
          )}
          data-slot="hover-card-content"
          render={render}
          {...props}
        >
          {asChild ? null : children}
        </HoverCardPrimitive.Popup>
      </HoverCardPrimitive.Positioner>
    </HoverCardPrimitive.Portal>
  );
};

export { HoverCard, HoverCardTrigger, HoverCardContent };
