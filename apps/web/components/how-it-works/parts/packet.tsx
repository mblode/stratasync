import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

import type { Tone } from "./tone";
import { toneFill } from "./tone";

/**
 * One packet on the wire.
 *
 * Amber going up, green coming back — the reader watches the colour change at
 * the server, which is the whole page in one dot.
 */
export const Packet = ({
  className,
  label,
  style,
  tone,
}: {
  className?: string;
  /** Rendered beside the dot, not inside it. Text never scales with a dot. */
  label?: string;
  style?: CSSProperties;
  tone: Tone;
}) => (
  <span className={cn("flex items-center gap-1.5", className)} style={style}>
    <span
      className={cn(
        "size-2.5 shrink-0 rounded-full shadow-[var(--packet-glow)]",
        toneFill[tone]
      )}
    />
    {label ? (
      <span className="whitespace-nowrap font-mono text-[0.6875rem] text-muted-foreground tabular-figures">
        {label}
      </span>
    ) : null}
  </span>
);
