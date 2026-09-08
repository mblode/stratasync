import { cn } from "@/lib/utils";

import { Packet } from "./packet";
import type { Tone } from "./tone";
import { toneFill } from "./tone";

/**
 * One task, the way a device shows it: a tick and a title.
 *
 * Display only. Every figure on the page runs itself, so the row is never a
 * control, and a checkbox that looked pressable would invite a press that did
 * nothing. The dot on the right is the one piece of state the page uses
 * everywhere: amber means only this device knows, green means the server has
 * it too.
 */
export const TaskRow = ({
  className,
  done,
  note,
  title,
  tone = "neutral",
}: {
  className?: string;
  done: boolean;
  /** A word or two beside the dot, e.g. `sending`. */
  note?: string;
  title: string;
  tone?: Tone;
}) => (
  <div
    className={cn(
      "flex min-h-9 items-center gap-2.5 rounded-lg bg-background px-2.5 py-1.5",
      className
    )}
  >
    <span
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors duration-300",
        done
          ? cn(
              "border-transparent",
              toneFill[tone === "neutral" ? "synced" : tone]
            )
          : "border-border bg-card"
      )}
    >
      {done ? (
        <svg
          className="size-3 text-background"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2.5"
          viewBox="0 0 16 16"
        >
          <path d="M3.5 8.5l2.75 2.75L12.5 5" />
        </svg>
      ) : null}
    </span>

    <span
      className={cn(
        "truncate text-sm transition-colors duration-300",
        done && "text-muted-foreground line-through"
      )}
    >
      {title}
    </span>
    <span className="sr-only">{done ? ", done" : ", not done"}</span>

    {tone === "neutral" ? null : (
      <Packet className="ml-auto shrink-0" label={note} tone={tone} />
    )}
  </div>
);
