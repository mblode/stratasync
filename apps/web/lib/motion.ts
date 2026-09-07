"use client";

import { useReducedMotion } from "motion/react";

/**
 * The house entrance curve and the reduced-motion collapse, in one place.
 *
 * `globals.css` zeroes every `animation-duration` and `transition-duration`
 * under `prefers-reduced-motion`, but that only reaches CSS. Motion's
 * JS-driven animations and any rAF loop run regardless, so every animated
 * component has to check for itself — which `landing-how.tsx` and
 * `landing-gap.tsx` both did, with their own copy of these three lines.
 */
export const EASE_ENTER = [0.22, 1, 0.36, 1] as const;

export interface MotionTiming {
  /** Delay in seconds, collapsed to 0 when motion is reduced. */
  del: (ms: number) => number;
  /** Duration in seconds, collapsed to 0 when motion is reduced. */
  dur: (ms: number) => number;
  ease: typeof EASE_ENTER;
  reduced: boolean;
}

export const useMotionTiming = (): MotionTiming => {
  const reduced = useReducedMotion() ?? false;

  return {
    del: (ms: number) => (reduced ? 0 : ms / 1000),
    dur: (ms: number) => (reduced ? 0 : ms / 1000),
    ease: EASE_ENTER,
    reduced,
  };
};
