"use client";

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PauseIcon,
  PlayIcon,
  RotateIcon,
} from "blode-icons-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

import type { FigureState } from "./use-figure-state";

/**
 * The control shelf every figure shares.
 *
 * Figure-specific controls sit on the left; `Back · Step n/m · Reset` is
 * always in the same place on the right, so the reader learns the interface
 * once and spends the rest of the page on the ideas.
 *
 * `Play` is not rendered at all under reduced motion. An auto-advancing figure
 * is precisely what that reader opted out of, and every state it would have
 * reached is still one press of `Next` away.
 */
export const FigureControls = ({
  children,
  state,
}: {
  children?: ReactNode;
  state: FigureState;
}) => {
  const {
    back: handleBack,
    next: handleNext,
    reset: handleReset,
    togglePlay: handleTogglePlay,
  } = state;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      {children ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {children}
        </div>
      ) : null}

      <div className="flex items-center gap-1 @md/figure:ml-auto">
        <Button
          aria-label="Previous step"
          disabled={state.atStart}
          onClick={handleBack}
          size="icon-sm"
          variant="outline"
        >
          <ChevronLeftIcon />
        </Button>

        <span className="min-w-16 text-center font-mono text-muted-foreground text-xs tabular-figures">
          Step {state.step + 1}/{state.stepCount}
        </span>

        <Button
          aria-label="Next step"
          disabled={state.atEnd}
          onClick={handleNext}
          size="icon-sm"
          variant="outline"
        >
          <ChevronRightIcon />
        </Button>

        {state.reduced ? null : (
          <Button
            aria-label={state.playing ? "Pause" : "Play"}
            disabled={state.atEnd}
            onClick={handleTogglePlay}
            size="icon-sm"
            variant="outline"
          >
            {state.playing ? <PauseIcon /> : <PlayIcon />}
          </Button>
        )}

        <Button
          className="ml-1"
          disabled={state.atStart}
          onClick={handleReset}
          size="sm"
          variant="ghost"
        >
          <RotateIcon />
          Reset
        </Button>
      </div>
    </div>
  );
};
