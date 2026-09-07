"use client";

import { useInView, useReducedMotion } from "motion/react";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Step state for one figure.
 *
 * The governing rule of the page is that step controls are the interface and
 * animation is a tween between two states the reader could have reached by
 * pressing a button. So the step index is the whole model: every figure
 * derives its stage from `step`, and nothing is encoded in motion alone.
 *
 * Autoplay is one beat, never a loop. It fires once when the figure first
 * comes into view, and never after the reader has touched anything — silently
 * rewinding someone mid-experiment is the classic scrollytelling bug.
 */
export interface FigureState {
  atEnd: boolean;
  atStart: boolean;
  back: () => void;
  /** True once the reader has pressed anything. Autoplay never fires again. */
  hasInteracted: boolean;
  inView: boolean;
  next: () => void;
  /** True while the run loop is advancing steps on its own. */
  playing: boolean;
  /** `prefers-reduced-motion`. Read it; do not animate around it. */
  reduced: boolean;
  ref: RefObject<HTMLElement | null>;
  reset: () => void;
  step: number;
  stepCount: number;
  /** Start or stop the run loop. Never rendered under reduced motion. */
  togglePlay: () => void;
  /** Jump to a step. For controls that are not Back or Next. */
  to: (step: number) => void;
}

interface Options {
  /** How long after entering view the single autoplay beat fires. */
  autoplayMs?: number;
  /** Seconds-ish between steps while `Play` is held down by the run loop. */
  playMs?: number;
  /** Total steps, including step 0. */
  stepCount: number;
}

export const useFigureState = ({
  autoplayMs = 900,
  playMs = 1200,
  stepCount,
}: Options): FigureState => {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { amount: 0.4 });
  const reduced = useReducedMotion() ?? false;

  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const hasAutoplayed = useRef(false);

  const to = useCallback(
    (next: number) => {
      setHasInteracted(true);
      setPlaying(false);
      setStep(Math.min(Math.max(next, 0), stepCount - 1));
    },
    [stepCount]
  );

  const next = useCallback(() => {
    to(step + 1);
  }, [step, to]);

  const back = useCallback(() => {
    to(step - 1);
  }, [step, to]);

  const reset = useCallback(() => {
    setHasInteracted(true);
    setPlaying(false);
    setStep(0);
  }, []);

  const togglePlay = useCallback(() => {
    setHasInteracted(true);
    setPlaying((current) => !current);
  }, []);

  /*
   * The run loop. Scrolling away pauses it and leaves the figure exactly where
   * it stands; it never rewinds work the reader started.
   */
  useEffect(() => {
    if (!(playing && inView)) {
      return;
    }

    if (step >= stepCount - 1) {
      setPlaying(false);
      return;
    }

    const timer = setTimeout(() => {
      setStep((current) => Math.min(current + 1, stepCount - 1));
    }, playMs);

    return () => clearTimeout(timer);
  }, [inView, playMs, playing, step, stepCount]);

  useEffect(() => {
    if (reduced || hasInteracted || hasAutoplayed.current || !inView) {
      return;
    }

    const timer = setTimeout(() => {
      hasAutoplayed.current = true;
      // Not `to`: autoplay must not count as an interaction, or a figure that
      // autoplays could never autoplay a second figure's worth of beats.
      setStep((current) => (current === 0 ? 1 : current));
    }, autoplayMs);

    return () => clearTimeout(timer);
  }, [autoplayMs, hasInteracted, inView, reduced]);

  return {
    atEnd: step >= stepCount - 1,
    atStart: step === 0,
    back,
    hasInteracted,
    inView,
    next,
    playing,
    reduced,
    ref,
    reset,
    step,
    stepCount,
    to,
    togglePlay,
  };
};
