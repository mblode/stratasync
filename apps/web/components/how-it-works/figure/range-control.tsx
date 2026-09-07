"use client";

import { useCallback, useId } from "react";

import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

/**
 * A continuous control.
 *
 * The house slider rather than a native `<input type="range">`. Base UI takes
 * and returns an array, because one track can carry several thumbs; every
 * figure here has one value, so the array is unwrapped at this boundary and no
 * caller has to know about it.
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
  /** How the current value reads. */
  format: (value: number) => string;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step?: number;
  value: number;
}) => {
  const labelId = useId();
  const handleValueChange = useCallback(
    (next: number[]) => onChange(next[0] ?? min),
    [min, onChange]
  );

  return (
    <span className={cn("flex items-center gap-2", className)}>
      <span className="whitespace-nowrap text-xs" id={labelId}>
        {label}
      </span>
      {/* The house slider is `w-full`, so it needs a parent with a width to
          fill; sized here rather than on the slider, whose own class wins. */}
      <span className="w-24 shrink-0 @md/figure:w-32">
        <Slider
          aria-labelledby={labelId}
          max={max}
          min={min}
          onValueChange={handleValueChange}
          step={step}
          value={[value]}
        />
      </span>
      <span className="min-w-11 text-muted-foreground text-xs tabular-nums">
        {format(value)}
      </span>
    </span>
  );
};
