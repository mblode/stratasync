"use client";

import { useCallback, useId } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

import type { Tone } from "./tone";

/**
 * The checkbox the whole page is built from.
 *
 * The house checkbox, not a hand-rolled one, so the tick draws itself the way
 * every other checkbox on the site does. Amber is not a second style: the
 * component paints itself from `--primary`, so a pending row reassigns that
 * one token locally and the fill, the border and the tick all follow.
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
  const id = useId();
  const handleCheckedChange = useCallback(() => onToggle?.(), [onToggle]);

  return (
    <div
      className={cn(
        "flex min-h-9 items-center gap-2.5 rounded-lg bg-background px-2.5 py-1.5",
        className
      )}
    >
      <Checkbox
        checked={done}
        className={cn(
          "size-4 rounded-[4px]",
          tone === "pending" &&
            "[--primary-foreground:var(--warning-foreground)] [--primary:var(--warning)]",
          onToggle ? "cursor-pointer" : "cursor-default"
        )}
        disabled={!onToggle}
        id={id}
        onCheckedChange={handleCheckedChange}
      />

      <Label
        className={cn(
          "truncate font-normal text-sm",
          done && "text-muted-foreground line-through",
          onToggle ? "cursor-pointer" : "cursor-default"
        )}
        htmlFor={id}
      >
        {title}
      </Label>

      {note ? (
        <span className="ml-auto shrink-0 text-[0.6875rem] text-muted-foreground tabular-nums">
          {note}
        </span>
      ) : null}
    </div>
  );
};
