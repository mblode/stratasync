import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/utils";

import type { Tone } from "./tone";
import { toneFill, toneSurface } from "./tone";

/**
 * One change: a field and its new value.
 *
 * The same shape whether it is waiting on a phone or numbered on the server.
 * The only difference is what sits at the left edge: a dot while it is only a
 * device's, and the number the server gave it once it is everyone's.
 */
export const Change = ({
  className,
  field,
  note,
  number,
  tone = "pending",
  value,
}: {
  className?: string;
  field: string;
  /** Where it came from, or what became of it. */
  note?: string;
  /** The server's number. Absent until the server has it. */
  number?: number;
  tone?: Tone;
  /** Rendered as the reader would type it, quotes and all. */
  value: string;
}) => (
  <div
    className={cn(
      "flex min-h-8 items-center gap-2 rounded-md border px-2 py-1",
      toneSurface[tone],
      className
    )}
  >
    {number === undefined ? (
      <span
        aria-hidden="true"
        className={cn("size-2 shrink-0 rounded-full", toneFill[tone])}
      />
    ) : (
      <span className="w-5 shrink-0 font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
        #{number}
      </span>
    )}
    <code className="truncate font-mono text-xs">
      {field} → {value}
    </code>
    {note ? (
      <span className="ml-auto shrink-0 text-[0.6875rem] text-muted-foreground">
        {note}
      </span>
    ) : null}
  </div>
);

/** Height of one `Change` plus the gap under it, so a list can hold its place. */
const ROW = 2;
const GAP = 0.375;

/**
 * A list of changes, with room reserved for the rows it will grow into, so
 * nothing below the figure moves when one lands.
 */
export const ChangeList = ({
  children,
  className,
  empty,
  label,
  rows,
}: {
  children?: ReactNode;
  className?: string;
  /** Shown while the list has nothing in it. */
  empty: string;
  label: string;
  /** How many rows the list will hold at most. */
  rows: number;
}) => {
  const style: CSSProperties = {
    minHeight: `${rows * ROW + (rows - 1) * GAP}rem`,
  };
  const hasRows = Array.isArray(children)
    ? children.some(Boolean)
    : Boolean(children);

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <p className="font-sans text-[0.6875rem] text-muted-foreground">
        {label}
      </p>
      {hasRows ? (
        <ol className="flex flex-col gap-1.5" style={style}>
          {children}
        </ol>
      ) : (
        <p
          className="flex items-start text-muted-foreground text-xs"
          style={style}
        >
          {empty}
        </p>
      )}
    </div>
  );
};
