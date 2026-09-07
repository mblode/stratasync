"use client";

import type { ReactNode } from "react";
import { useId } from "react";

import { cn } from "@/lib/utils";

import { FigureControls } from "./figure-controls";
import { FigureStatus } from "./figure-status";
import type { FigureState } from "./use-figure-state";

interface Props {
  /** Prose. States the mechanism; never narrates the interaction. */
  caption: ReactNode;
  /** The stage. */
  children: ReactNode;
  /** Controls specific to this figure. The step group is added for you. */
  controls?: ReactNode;
  /** Matches the section number. */
  n: number;
  /** Fixed height, so nothing reflows as the state changes. */
  stageClassName?: string;
  state: FigureState;
  /** The one spoken line. Rewritten on step boundaries only. */
  status: string;
  title: string;
}

/**
 * The frame every figure on this page sits in.
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
  n,
  stageClassName,
  state,
  status,
  title,
}: Props) => {
  const titleId = useId();

  return (
    <figure
      ref={state.ref}
      aria-labelledby={titleId}
      className="@container/figure my-10"
      data-not-typeset
    >
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <header className="flex items-baseline gap-2.5 border-border border-b px-4 py-2.5">
          <span className="font-mono text-muted-foreground text-xs tabular-figures">
            Fig. {n}
          </span>
          <h3 className="font-sans font-medium text-sm" id={titleId}>
            {title}
          </h3>
        </header>

        <div className={cn("px-4 py-5", stageClassName)}>{children}</div>

        {/*
          The surface step is what makes the shelf read as chrome the reader
          operates rather than content they read.
        */}
        <div className="space-y-2 border-border border-t bg-surface px-4 py-3">
          <FigureControls state={state}>{controls}</FigureControls>
          <FigureStatus text={status} />
        </div>
      </div>

      <figcaption className="mt-3 text-muted-foreground text-sm">
        {caption}
      </figcaption>
    </figure>
  );
};
