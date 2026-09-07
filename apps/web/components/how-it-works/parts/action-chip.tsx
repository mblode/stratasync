import { cn } from "@/lib/utils";

import type { Tone } from "./tone";
import { toneFill, toneSurface } from "./tone";

/** The sync action codes the protocol actually sends. */
export type ActionCode = "A" | "C" | "D" | "G" | "I" | "U" | "V";

const codeName: Record<ActionCode, string> = {
  A: "archive",
  C: "coverage",
  D: "delete",
  G: "group",
  I: "insert",
  U: "update",
  V: "unarchive",
};

/**
 * One row of the server's log.
 *
 * Same footprint as a `TxChip`, with a wedge on the left edge pointing into
 * the box: this one arrived from the server rather than starting here.
 */
export const ActionChip = ({
  className,
  code,
  id,
  summary,
  tone = "synced",
}: {
  className?: string;
  code: ActionCode;
  /** The live `syncId`. Never a constant — the log allocates these. */
  id: string;
  summary: string;
  tone?: Tone;
}) => (
  <div
    className={cn(
      "flex min-h-9 items-center gap-2 rounded-md border py-1.5 pr-2.5 pl-1.5",
      toneSurface[tone],
      className
    )}
  >
    <span
      aria-hidden="true"
      className={cn("h-3.5 w-2 shrink-0", toneFill[tone])}
      style={{ clipPath: "polygon(0 0, 100% 50%, 0 100%)" }}
    />
    <code className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground tabular-figures">
      {id}
    </code>
    {/* The word, not the protocol's letter. A reader should not have to hold
        a five-letter legend in their head to read the log. */}
    <span className="shrink-0 font-sans text-xs">{codeName[code]}</span>
    <code className="truncate font-mono text-xs">{summary}</code>
  </div>
);

export { codeName };
