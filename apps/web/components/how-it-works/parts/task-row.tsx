"use client";

import { CheckIcon } from "blode-icons-react";

import { cn } from "@/lib/utils";

import type { Tone } from "./tone";

/**
 * The checkbox the whole page is built from.
 *
 * Always a real `<button>` with `aria-pressed`, so every figure that asks the
 * reader to tick something is reachable from the keyboard and announces its
 * state, whether or not the tick has reached the server yet.
 */
export const TaskRow = ({
  className,
  done,
  note,
  onToggle,
  title,
  tone = "neutral",
}: {
  className?: string;
  done: boolean;
  /** Right-aligned state, e.g. `Saving…`. */
  note?: string;
  onToggle?: () => void;
  title: string;
  /** The tick's colour: whether the server knows about this yet. */
  tone?: Tone;
}) => {
  const boxTone =
    tone === "pending"
      ? "border-warning bg-warning text-warning-foreground"
      : "border-primary bg-primary text-primary-foreground";

  return (
    <div
      className={cn(
        "flex min-h-9 items-center gap-2.5 rounded-md border border-border bg-background px-2.5 py-1.5",
        className
      )}
    >
      <button
        aria-label={title}
        aria-pressed={done}
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
          done ? boxTone : "border-input bg-background hover:border-ring",
          onToggle ? "cursor-pointer" : "cursor-default"
        )}
        disabled={!onToggle}
        onClick={onToggle}
        type="button"
      >
        {done ? <CheckIcon className="size-3" /> : null}
      </button>

      <span
        className={cn(
          "truncate font-sans text-sm",
          done && "text-muted-foreground line-through"
        )}
      >
        {title}
      </span>

      {note ? (
        <span className="ml-auto shrink-0 font-mono text-[0.6875rem] text-muted-foreground tabular-figures">
          {note}
        </span>
      ) : null}
    </div>
  );
};
