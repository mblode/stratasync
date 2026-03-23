"use client";

import { WifiFullIcon, WifiNoSignalIcon } from "blode-icons-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { Button } from "@/components/ui/button";

export const NetworkToggle = ({
  isOnline,
  onToggle,
}: {
  isOnline: boolean;
  onToggle: () => void;
}) => {
  const reduceMotion = useReducedMotion();

  return (
    <Button
      aria-label={isOnline ? "Go offline" : "Go online"}
      aria-pressed={!isOnline}
      className="relative h-7 w-7 cursor-pointer"
      onClick={onToggle}
      size="icon"
      type="button"
      variant="ghost"
    >
      <AnimatePresence initial={false} mode="wait">
        {isOnline ? (
          <motion.span
            key="online"
            animate={{
              filter: "blur(0px)",
              opacity: 1,
              transition: { duration: 0.15 },
            }}
            className="text-muted-foreground"
            exit={{
              filter: reduceMotion ? undefined : "blur(4px)",
              opacity: 0,
              transition: { duration: 0.1 },
            }}
            initial={{
              filter: reduceMotion ? undefined : "blur(4px)",
              opacity: 0,
            }}
          >
            <WifiFullIcon aria-hidden="true" className="h-3.5 w-3.5" />
          </motion.span>
        ) : (
          <motion.span
            key="offline"
            animate={{
              filter: "blur(0px)",
              opacity: 1,
              transition: { duration: 0.15 },
            }}
            className="text-destructive"
            exit={{
              filter: reduceMotion ? undefined : "blur(4px)",
              opacity: 0,
              transition: { duration: 0.1 },
            }}
            initial={{
              filter: reduceMotion ? undefined : "blur(4px)",
              opacity: 0,
            }}
          >
            <WifiNoSignalIcon aria-hidden="true" className="h-3.5 w-3.5" />
          </motion.span>
        )}
      </AnimatePresence>
    </Button>
  );
};
