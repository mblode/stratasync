"use client";

import { useInView, useReducedMotion } from "motion/react";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Step state for one figure.
 *
 * The figure runs itself. It starts when it scrolls into view, holds a beat on
 * each stage, and loops, so a reader who does nothing still sees the whole
 * mechanism. Every transition between stages is a tween, so what they watch is
 * continuous even though the model underneath is a small integer.
 *
 * Looping past the end is a replay, not a rewind. A syncId the server has
 * handed out is never handed out again, so the live figures reseed and run
 * their sequence from the top.
 */
export interface FigureState {
  /** Pause and resume. The only control the shell renders. */
  handleToggle: () => void;
  inView: boolean;
  /** The reader's intent, not whether a beat is currently elapsing. */
  playing: boolean;
  ref: RefObject<HTMLElement | null>;
  step: number;
  stepCount: number;
  /** Jump to a step. Figure controls go through this. */
  to: (step: number) => void;
}

interface Options {
  /** How long one stage is held. */
  beatMs?: number;
  /** Total steps, including step 0. */
  stepCount: number;
}

/** The end of the loop is held longer, so the last stage is readable. */
const LOOP_HOLD = 1.8;

export const useFigureState = ({
  beatMs = 1800,
  stepCount,
}: Options): FigureState => {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { amount: 0.4 });
  const reduced = useReducedMotion() ?? false;

  const [step, setStep] = useState(0);
  // Reduced motion opts out of the loop, not out of the figure: the button
  // still runs it, and every stage is a state the DOM reaches at rest.
  const [playing, setPlaying] = useState(!reduced);

  const to = useCallback(
    (next: number) => setStep(Math.min(Math.max(next, 0), stepCount - 1)),
    [stepCount]
  );

  const handleToggle = useCallback(() => setPlaying((current) => !current), []);

  /* Scrolling away holds the figure exactly where it stands. */
  useEffect(() => {
    if (!(playing && inView)) {
      return;
    }

    const last = step >= stepCount - 1;
    const timer = setTimeout(
      () => setStep((current) => (current >= stepCount - 1 ? 0 : current + 1)),
      last ? beatMs * LOOP_HOLD : beatMs
    );

    return () => clearTimeout(timer);
  }, [beatMs, inView, playing, step, stepCount]);

  return { handleToggle, inView, playing, ref, step, stepCount, to };
};
