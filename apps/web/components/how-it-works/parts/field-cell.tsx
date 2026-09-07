import { cn } from "@/lib/utils";

import type { Tone } from "./tone";
import { toneSurface } from "./tone";

/**
 * One field of one row, for the rebase figure.
 *
 * Key over value rather than key beside value: at 340px a `title` and a
 * quoted string do not fit on one line, and the rule for this page is that
 * nothing is hidden and no label is abbreviated.
 */
export const FieldCell = ({
  className,
  name,
  note,
  tone = "neutral",
  value,
}: {
  className?: string;
  name: string;
  /** Where the value came from, e.g. `local` or `server`. */
  note?: string;
  tone?: Tone;
  /** Rendered exactly as a reader would type it, quotes and all. */
  value: string;
}) => (
  <div
    className={cn(
      "rounded-lg border px-2.5 py-1.5",
      toneSurface[tone],
      className
    )}
  >
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[0.6875rem] text-muted-foreground">{name}</span>
      {note ? (
        <span className="text-[0.6875rem] text-muted-foreground">{note}</span>
      ) : null}
    </div>
    <code className="mt-0.5 block truncate font-mono text-xs">{value}</code>
  </div>
);
