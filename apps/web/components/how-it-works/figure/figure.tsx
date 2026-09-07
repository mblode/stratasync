"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { FigurePlayback } from "./figure-controls";
import { FigureStatus } from "./figure-status";
import type { FigureState } from "./use-figure-state";

interface Props {
  /** Prose. States the mechanism; never narrates the interaction. */
  caption: ReactNode;
  /** The stage. */
  children: ReactNode;
  /** Controls specific to this figure. Playback is added for you. */
  controls?: ReactNode;
  /** Fixed height, so nothing reflows as the state changes. */
  stageClassName?: string;
  state: FigureState;
  /** The one spoken line. Rewritten on step boundaries only. */
  status: string;
  /** The figure's accessible name. Not rendered: the prose introduces it. */
  title: string;
}

/**
 * The frame every figure on this page sits in, which is no frame at all.
 *
 * There was a card here once, with a border, a titled header bar and a tinted
 * control shelf, and it made every figure a nested box inside a box. The
 * diagram is the thing worth looking at, so it sits on the page like a
 * paragraph does and the pause button sits quietly under it.
 *
 * `data-not-typeset` is load-bearing, not decoration: `.typeset` restyles
 * arbitrary descendants, so without it the article's own margins and type
 * scale reach inside every `<p>`, `<code>` and `<ul>` a figure renders.
 *
 * `@container/figure` rather than viewport breakpoints. A figure must not care
 * how wide the window is, only how wide it is; below the breakpoint every one
 * of them is a single-column stack with nothing hidden and no label shortened.
 */
export const Figure = ({
  caption,
  children,
  controls,
  stageClassName,
  state,
  status,
  title,
}: Props) => (
  <figure
    ref={state.ref}
    aria-label={title}
    className="@container/figure my-12"
    data-not-typeset
  >
    <div className={cn(stageClassName)}>{children}</div>

    <div className="mt-5 flex flex-col gap-3">
      {controls ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {controls}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <FigurePlayback state={state} />
        <FigureStatus text={status} />
      </div>
    </div>

    <figcaption className="mt-5 text-muted-foreground text-sm">
      {caption}
    </figcaption>
  </figure>
);
