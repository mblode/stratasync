"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import * as React from "react";

import { cn } from "@/lib/utils.js";

const TooltipProvider = ({
  delayDuration,
  delay = delayDuration ?? 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider> & {
  delayDuration?: number;
}) => (
  <TooltipPrimitive.Provider
    data-slot="tooltip-provider"
    delay={delay}
    {...props}
  />
);

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = ({
  asChild = false,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger> & {
  asChild?: boolean;
}) => {
  const render =
    asChild && React.isValidElement(children)
      ? (children as React.ReactElement)
      : undefined;

  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      render={render}
      {...props}
    >
      {asChild ? null : children}
    </TooltipPrimitive.Trigger>
  );
};

type TooltipContentProps = React.ComponentPropsWithoutRef<
  typeof TooltipPrimitive.Popup
> &
  Pick<
    React.ComponentProps<typeof TooltipPrimitive.Positioner>,
    "align" | "alignOffset" | "side" | "sideOffset"
  > & {
    asChild?: boolean;
  };

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Popup>,
  TooltipContentProps
>(
  (
    {
      asChild = false,
      className,
      side = "top",
      sideOffset = 8,
      align = "center",
      alignOffset = 0,
      children,
      ...props
    },
    ref
  ) => {
    const render =
      asChild && React.isValidElement(children)
        ? (children as React.ReactElement)
        : undefined;

    return (
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner
          align={align}
          alignOffset={alignOffset}
          className="isolate z-110"
          side={side}
          sideOffset={sideOffset}
        >
          <TooltipPrimitive.Popup
            className={cn(
              "fade-in-0 zoom-in-95 data-closed:fade-out-0 data-closed:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 relative z-110 origin-(--transform-origin) animate-in rounded-xl bg-gray-900 px-3 py-2 font-normal font-sans text-sm text-white shadow-soft ring-1 ring-gray-700 data-closed:animate-out motion-reduce:animate-none",
              className
            )}
            ref={ref}
            render={render}
            {...props}
          >
            {asChild ? null : children}
            <TooltipPrimitive.Arrow className="pointer-events-none absolute size-2.5 -rotate-45 rounded-bl-[3px] border border-gray-700 bg-gray-900 [clip-path:polygon(0_100%,0_0,100%_100%)] data-[side=bottom]:top-0 data-[side=left]:right-0 data-[side=top]:bottom-0 data-[side=right]:left-0 data-[side=left]:translate-x-1/2 data-[side=right]:-translate-x-1/2 data-[side=bottom]:-translate-y-1/2 data-[side=top]:translate-y-1/2" />
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    );
  }
);
TooltipContent.displayName = TooltipPrimitive.Popup.displayName;

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
