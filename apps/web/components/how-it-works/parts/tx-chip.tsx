import { cn } from "@/lib/utils";

import type { Tone } from "./tone";
import { toneSurface } from "./tone";

/** The real lifecycle from `packages/client`, not a simplification of it. */
export type TxState =
  | "awaitingSync"
  | "completed"
  | "failed"
  | "queued"
  | "sent";

const stateTone: Record<TxState, Tone> = {
  awaitingSync: "pending",
  completed: "synced",
  failed: "lost",
  queued: "pending",
  sent: "pending",
};

/**
 * A transaction as it sits in the outbox.
 *
 * Device-origin, so no notch: the flat left edge is what distinguishes it from
 * an `ActionChip` at a glance, without reading either.
 */
/** The height a chip occupies, so an empty outbox can hold its place. */
export const TX_CHIP_HEIGHT = "min-h-[3.25rem]";

export const TxChip = ({
  className,
  clientTxId,
  needs,
  state,
  summary,
}: {
  className?: string;
  clientTxId: string;
  /** `syncIdNeededForCompletion`, once the server has answered. */
  needs?: string;
  state: TxState;
  /** What the write does, e.g. `done = true`. */
  summary: string;
}) => (
  /*
   * Two lines, always. One line has to hold an id, a summary, a state name and
   * a syncId, and at 340px something would have to be shortened — and a chip
   * that abbreviates `awaitingSync` teaches the wrong word.
   */
  <div
    className={cn(
      "flex min-h-[3.25rem] flex-col justify-center gap-0.5 rounded-md border px-2.5 py-1.5",
      toneSurface[stateTone[state]],
      className
    )}
  >
    <div className="flex items-baseline justify-between gap-2">
      <code className="font-mono text-[0.6875rem] text-muted-foreground">
        {clientTxId}
      </code>
      <code className="font-mono text-[0.6875rem]">{state}</code>
    </div>
    <div className="flex items-baseline justify-between gap-2">
      <code className="font-mono text-xs">{summary}</code>
      {needs ? (
        <code className="font-mono text-[0.6875rem] text-muted-foreground tabular-figures">
          needs {needs}
        </code>
      ) : null}
    </div>
  </div>
);
