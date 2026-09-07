"use client";

import type { ChangeEvent } from "react";
import { useCallback, useId } from "react";

import { cn } from "@/lib/utils";

/**
 * A continuous control.
 *
 * Native `<input type="range">` rather than either installed slider component:
 * a platform feature sits above a dependency on the ladder, and it arrives
 * with keyboard support and `aria-valuenow` already correct.
 */
export const RangeControl = ({
  className,
  format,
  label,
  max,
  min,
  onChange,
  step = 1,
  value,
}: {
  className?: string;
  /** How the current value reads. Rendered in `tabular-figures`. */
  format: (value: number) => string;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step?: number;
  value: number;
}) => {
  const id = useId();
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange(Number(event.target.value)),
    [onChange]
  );

  return (
    <span className={cn("flex items-center gap-2", className)}>
      <label className="whitespace-nowrap font-sans text-xs" htmlFor={id}>
        {label}
      </label>
      <input
        className="h-1.5 w-24 cursor-pointer accent-primary @md/figure:w-32"
        id={id}
        max={max}
        min={min}
        onChange={handleChange}
        step={step}
        type="range"
        value={value}
      />
      <output
        className="min-w-11 font-mono text-muted-foreground text-xs tabular-figures"
        htmlFor={id}
      >
        {format(value)}
      </output>
    </span>
  );
};
