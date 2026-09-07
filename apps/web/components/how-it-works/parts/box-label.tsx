import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import type { Tone } from "./tone";
import { toneText } from "./tone";

/**
 * What a box is, and where it has got to. Above the box rather than in a
 * header bar inside it: one fewer rule, one fewer fill, same information.
 */
export const BoxLabel = ({
  label,
  status,
  tone,
}: {
  label: string;
  status?: ReactNode;
  tone?: Tone;
}) => (
  <div className="flex items-baseline justify-between gap-2 px-1 pb-1.5">
    <span className={cn("font-medium text-xs", tone && toneText[tone])}>
      {label}
    </span>
    {status ? (
      <span className="text-[0.6875rem] text-muted-foreground tabular-nums">
        {status}
      </span>
    ) : null}
  </div>
);
