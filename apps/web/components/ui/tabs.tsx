"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cva, type VariantProps } from "class-variance-authority";
import mergeRefs from "merge-refs";
import * as React from "react";

import { cn } from "@/lib/utils";
import { useTabObserver } from "@/lib/use-tab-observer";

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className
      )}
      data-orientation={orientation}
      data-slot="tabs"
      orientation={orientation}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  "group/tabs-list relative isolate inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground data-[variant=line]:rounded-none group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

function TabsList({
  className,
  variant = "default",
  ref,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  const [indicatorStyle, setIndicatorStyle] = React.useState({
    height: 0,
    left: 0,
    top: 0,
    width: 0,
  });
  const [hasIndicatorPosition, setHasIndicatorPosition] = React.useState(false);
  const [canAnimateIndicator, setCanAnimateIndicator] = React.useState(false);
  const hasInitializedIndicator = React.useRef(false);
  const { listRef } = useTabObserver({
    onActiveTabChange: (_, activeTab) => {
      setIndicatorStyle({
        height: activeTab.offsetHeight,
        left: activeTab.offsetLeft,
        top: activeTab.offsetTop,
        width: activeTab.offsetWidth,
      });

      if (!hasInitializedIndicator.current) {
        hasInitializedIndicator.current = true;
        setHasIndicatorPosition(true);
        requestAnimationFrame(() => {
          setCanAnimateIndicator(true);
        });
        return;
      }

      setHasIndicatorPosition(true);
    },
  });

  return (
    <TabsPrimitive.List
      className={cn(tabsListVariants({ variant }), className)}
      data-slot="tabs-list"
      data-variant={variant}
      ref={mergeRefs(ref, listRef)}
      {...props}
    >
      {variant === "default" ? (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute top-0 left-0 z-0 rounded-md bg-background shadow-sm",
            canAnimateIndicator
              ? "transition-[width,height,transform,opacity] duration-300"
              : "transition-none",
            hasIndicatorPosition ? "opacity-100" : "opacity-0"
          )}
          style={{
            height: `${indicatorStyle.height}px`,
            transform: `translate(${indicatorStyle.left}px, ${indicatorStyle.top}px)`,
            transitionTimingFunction: "cubic-bezier(0.65, 0, 0.35, 1)",
            width: `${indicatorStyle.width}px`,
          }}
        />
      ) : null}
      {props.children}
    </TabsPrimitive.List>
  );
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Tab>) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "relative z-10 inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-1.5 py-0.5 font-medium text-foreground/60 text-sm transition-all hover:text-foreground focus-visible:border-ring focus-visible:outline-1 focus-visible:outline-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start group-data-[variant=line]/tabs-list:data-active:shadow-none dark:text-muted-foreground dark:hover:text-foreground [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
        "data-active:text-foreground group-data-[variant=default]/tabs-list:data-active:bg-transparent dark:data-active:text-foreground group-data-[variant=default]/tabs-list:dark:data-active:border-transparent group-data-[variant=default]/tabs-list:dark:data-active:bg-transparent",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className
      )}
      data-slot="tabs-trigger"
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Panel>) {
  return (
    <TabsPrimitive.Panel
      className={cn("flex-1 text-sm outline-none", className)}
      data-slot="tabs-content"
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
