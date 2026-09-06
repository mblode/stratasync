"use client";

import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";
import { motion } from "motion/react";
import type { HTMLMotionProps, Transition } from "motion/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

interface AccordionItemContextType {
  canAnimate: boolean;
  isOpen: boolean;
  setCanAnimate: (canAnimate: boolean) => void;
  setIsOpen: (open: boolean) => void;
}

const AccordionItemContext = createContext<
  AccordionItemContextType | undefined
>(undefined);

const useAccordionItem = (): AccordionItemContextType => {
  const context = useContext(AccordionItemContext);
  if (!context) {
    throw new Error("useAccordionItem must be used within an AccordionItem");
  }
  return context;
};

type AccordionValue = string | string[];

type AccordionProps = Omit<
  ComponentProps<typeof AccordionPrimitive.Root>,
  "defaultValue" | "multiple" | "onValueChange" | "value"
> & {
  type?: "single" | "multiple";
  collapsible?: boolean;
  value?: AccordionValue;
  defaultValue?: AccordionValue;
  onValueChange?: (value: AccordionValue) => void;
};

const normalizeAccordionValue = (
  value: AccordionValue | undefined
): string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value;
  }

  return value === "" ? [] : [value];
};

const Accordion = ({
  type = "single",
  collapsible = false,
  value,
  defaultValue,
  onValueChange,
  ...props
}: AccordionProps) => {
  const multiple = type === "multiple";

  const handleValueChange = useCallback(
    (nextValue: (unknown | null)[]) => {
      if (!onValueChange) {
        return;
      }

      const nextStringValues = nextValue.filter(
        (item): item is string => typeof item === "string"
      );

      if (multiple) {
        onValueChange(nextStringValues);
        return;
      }

      const [firstValue] = nextStringValues;
      if (firstValue !== undefined) {
        onValueChange(firstValue);
        return;
      }

      if (collapsible) {
        onValueChange("");
      }
    },
    [collapsible, multiple, onValueChange]
  );

  return (
    <AccordionPrimitive.Root
      data-slot="accordion"
      defaultValue={normalizeAccordionValue(defaultValue)}
      multiple={multiple}
      onValueChange={onValueChange ? handleValueChange : undefined}
      value={normalizeAccordionValue(value)}
      {...props}
    />
  );
};

const AccordionItem = ({
  className,
  children,
  ...props
}: ComponentProps<typeof AccordionPrimitive.Item>) => {
  const [isOpen, setIsOpen] = useState(false);
  const [canAnimate, setCanAnimate] = useState(false);

  const contextValue = useMemo(
    () => ({ canAnimate, isOpen, setCanAnimate, setIsOpen }),
    [canAnimate, isOpen]
  );

  return (
    <AccordionItemContext.Provider value={contextValue}>
      <AccordionPrimitive.Item
        className={cn("border-b last:border-b-0", className)}
        data-slot="accordion-item"
        {...props}
      >
        {children}
      </AccordionPrimitive.Item>
    </AccordionItemContext.Provider>
  );
};

type AccordionTriggerProps = ComponentProps<
  typeof AccordionPrimitive.Trigger
> & {
  chevron?: boolean;
};

const AccordionTrigger = ({
  ref,
  className,
  children,
  chevron = true,
  ...props
}: AccordionTriggerProps) => {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  useImperativeHandle(ref, () => triggerRef.current as HTMLButtonElement);
  const { isOpen, setIsOpen, canAnimate, setCanAnimate } = useAccordionItem();

  useEffect(() => {
    const node = triggerRef.current;
    if (!node) {
      return;
    }

    const updateState = () => {
      const isExpanded =
        Object.hasOwn(node.dataset, "panelOpen") ||
        node.getAttribute("aria-expanded") === "true";
      setIsOpen(isExpanded);
    };

    const observer = new MutationObserver((mutationsList) => {
      for (const mutation of mutationsList) {
        if (
          mutation.attributeName === "data-panel-open" ||
          mutation.attributeName === "aria-expanded"
        ) {
          updateState();
        }
      }
    });

    observer.observe(node, {
      attributeFilter: ["data-panel-open", "aria-expanded"],
      attributes: true,
    });

    // On initial `defaultValue`, Base UI applies the panel's `data-panel-open`
    // after this effect runs, and that first attribute write can land in a gap
    // the observer misses — leaving the panel collapsed until the user toggles
    // it. Re-read the open state across the first few frames so we reliably
    // catch it whenever Base UI writes it, then enable animation.
    let frameId = 0;
    let frames = 0;
    const syncOpenState = () => {
      updateState();
      frames += 1;
      if (frames < 5) {
        frameId = requestAnimationFrame(syncOpenState);
      } else {
        setCanAnimate(true);
      }
    };
    syncOpenState();

    return () => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [setCanAnimate, setIsOpen]);

  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        className={cn(
          "flex flex-1 cursor-pointer items-start justify-between gap-4 rounded-md py-4 text-left font-medium text-sm outline-none transition-[color,background-color,border-color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
          className
        )}
        data-slot="accordion-trigger"
        ref={triggerRef}
        {...props}
      >
        {children}
        {chevron ? (
          // Odd box and bar sizes (11px / 1px) keep each bar's centred offset a
          // whole number — (11 / 2) - (1 / 2) = 5px. At even sizes the 1.5px bar
          // landed on 5.25px, straddling two pixels and rendering soft.
          <div className="relative flex h-[11px] w-[11px] shrink-0 items-center justify-center">
            <motion.div
              animate={{ rotate: isOpen ? 180 : 0 }}
              className="absolute top-1/2 left-1/2 h-px w-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground"
              transition={
                canAnimate
                  ? { duration: 0.3, ease: [0.645, 0.045, 0.355, 1] }
                  : { duration: 0 }
              }
            />
            <motion.div
              animate={{ rotateZ: isOpen ? 90 : 0, scale: isOpen ? 0 : 1 }}
              className="absolute top-1/2 left-1/2 h-[11px] w-px -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground"
              style={{ transformOrigin: "center" }}
              transition={
                canAnimate
                  ? { duration: 0.3, ease: [0.645, 0.045, 0.355, 1] }
                  : { duration: 0 }
              }
            />
          </div>
        ) : null}
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
};

type AccordionContentProps = ComponentProps<typeof AccordionPrimitive.Panel> &
  HTMLMotionProps<"div"> & {
    transition?: Transition;
  };

const DEFAULT_ACCORDION_TRANSITION: Transition = {
  damping: 22,
  stiffness: 150,
  type: "spring",
};

const AccordionContent = ({
  className,
  children,
  transition = DEFAULT_ACCORDION_TRANSITION,
  ...props
}: AccordionContentProps) => {
  const { isOpen, canAnimate } = useAccordionItem();

  return (
    <AccordionPrimitive.Panel keepMounted {...props} hidden={false}>
      {/*
        Always mounted and collapsed to zero height when closed, rather than
        unmounted. The registry version rendered nothing for a closed panel,
        and `isOpen` starts false on the server, so every answer was missing
        from the served HTML. These panels hold FAQ answers that a FAQPage node
        claims and that answer engines read from the DOM, so the text has to
        be there before any click.
      */}
      <motion.div
        animate={
          isOpen
            ? { "--mask-stop": "100%", height: "auto", opacity: 1 }
            : { "--mask-stop": "0%", height: 0, opacity: 0 }
        }
        aria-hidden={!isOpen}
        className="overflow-hidden"
        data-slot="accordion-content"
        initial={false}
        style={{
          WebkitMaskImage:
            "linear-gradient(black var(--mask-stop), transparent var(--mask-stop))",
          maskImage:
            "linear-gradient(black var(--mask-stop), transparent var(--mask-stop))",
        }}
        transition={canAnimate ? transition : { duration: 0 }}
      >
        <div className={cn("pt-0 pb-4 text-sm leading-[1.5]", className)}>
          {children}
        </div>
      </motion.div>
    </AccordionPrimitive.Panel>
  );
};

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
