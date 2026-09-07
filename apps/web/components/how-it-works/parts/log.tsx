import { cn } from "@/lib/utils";

import type { ActionCode } from "./action-chip";
import { ActionChip } from "./action-chip";
import type { Tone } from "./tone";

export interface LogRow {
  code: ActionCode;
  /** The live `syncId` the server assigned. */
  id: string;
  summary: string;
  /**
   * Overrides what the cursor implies. A row below the cursor is normally one
   * this device has, which is exactly the assumption section 4 breaks.
   */
  tone?: Tone;
}

/**
 * The server's log.
 *
 * A real `<ol>`, because it literally is an ordered list and that ordering is
 * the lesson. A device's watermark renders as the rows above it being settled
 * and the rows below it being ones this device has not seen yet.
 */
export const Log = ({
  className,
  cursor,
  empty = "No actions yet.",
  rows,
}: {
  className?: string;
  /** This device's position in the log. Rows past it are dimmed. */
  cursor?: string;
  empty?: string;
  rows: LogRow[];
}) => {
  if (rows.length === 0) {
    return (
      <p className={cn("text-muted-foreground text-xs", className)}>{empty}</p>
    );
  }

  return (
    <ol className={cn("flex flex-col gap-1.5", className)}>
      {rows.map((row) => {
        // Sync IDs outgrow `Number.MAX_SAFE_INTEGER`, so they are decimal
        // strings on the wire. Compare them by length first, then lexically.
        const seen =
          cursor === undefined ||
          row.id.length < cursor.length ||
          (row.id.length === cursor.length && row.id <= cursor);

        const tone = row.tone ?? (seen ? "synced" : "neutral");

        return (
          <li key={row.id}>
            <ActionChip
              className={tone === "neutral" ? "opacity-45" : undefined}
              code={row.code}
              id={row.id}
              summary={row.summary}
              tone={tone}
            />
          </li>
        );
      })}
    </ol>
  );
};
