"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { Button } from "@/components/ui/button";

const WifiOnIcon = () => (
  <svg
    aria-hidden="true"
    className="h-3.5 w-3.5"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={2}
    viewBox="0 0 24 24"
  >
    <path d="M5 12.55a11 11 0 0 1 14.08 0" />
    <path d="M1.42 9a16 16 0 0 1 21.16 0" />
    <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
    <line x1={12} x2={12.01} y1={20} y2={20} />
  </svg>
);

const WifiOffIcon = () => (
  <svg
    aria-hidden="true"
    className="h-3.5 w-3.5"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={2}
    viewBox="0 0 24 24"
  >
    <line x1={1} x2={23} y1={1} y2={23} />
    <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
    <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
    <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
    <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
    <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
    <line x1={12} x2={12.01} y1={20} y2={20} />
  </svg>
);

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
            <WifiOnIcon />
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
            <WifiOffIcon />
          </motion.span>
        )}
      </AnimatePresence>
    </Button>
  );
};
