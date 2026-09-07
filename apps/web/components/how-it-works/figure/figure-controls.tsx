"use client";

import { PauseFilledIcon, PlayFilledIcon } from "blode-icons-react";

import { Button } from "@/components/ui/button";

import type { FigureState } from "./use-figure-state";

/**
 * The one control every figure shares.
 *
 * There were five here once, then three: play, pause, back, next, reset, a
 * step counter, a scrubber, a speed slider. The figure runs itself, so the
 * only thing left worth a button is stopping it.
 */
export const FigurePlayback = ({ state }: { state: FigureState }) => (
  <Button
    className="shrink-0"
    onClick={state.handleToggle}
    size="icon-sm"
    variant="secondary"
  >
    {state.playing ? <PauseFilledIcon /> : <PlayFilledIcon />}
    <span className="sr-only">{state.playing ? "Pause" : "Play"}</span>
  </Button>
);
