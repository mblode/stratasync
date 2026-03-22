"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import type { SyncAnimation } from "./types";

const DURATION = 0.5;
const MOVE_EASE = [0.25, 1, 0.5, 1] as const;

export const SyncFlow = ({ animations }: { animations: SyncAnimation[] }) => {
  const reduceMotion = useReducedMotion();

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none relative hidden self-stretch items-center md:flex"
    >
      {/* Pipe */}
      <div className="h-0.5 w-full rounded-full bg-border" />

      {/* Traveling dot */}
      <AnimatePresence>
        {animations.map((anim) => {
          const isRight = anim.direction === "right";

          return (
            <motion.div
              key={anim.id}
              animate={
                reduceMotion
                  ? { opacity: [0, 1, 0] }
                  : { x: isRight ? ["-8px", "48px"] : ["48px", "-8px"] }
              }
              className="absolute top-1/2 left-0 h-2 w-2 -translate-y-1/2 rounded-full bg-primary"
              exit={{ opacity: 0 }}
              initial={{
                opacity: 1,
                x: isRight ? "-8px" : "48px",
              }}
              transition={{
                duration: DURATION,
                ease: MOVE_EASE,
              }}
            />
          );
        })}
      </AnimatePresence>
    </div>
  );
};
