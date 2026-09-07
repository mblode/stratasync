"use client";

import { useCallback } from "react";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

/**
 * A segmented choice. Every option is always visible, because a figure that
 * hides one of its states behind a menu teaches half of what it could.
 */
export const ToggleControl = <T extends string>({
  className,
  label,
  onChange,
  options,
  value,
}: {
  className?: string;
  label: string;
  onChange: (value: T) => void;
  options: { label: string; value: T }[];
  value: T;
}) => {
  const handleValueChange = useCallback(
    (next: string) => {
      // Radix clears the value when the pressed item is pressed again.
      if (next) {
        onChange(next as T);
      }
    },
    [onChange]
  );

  return (
    // Wraps, so a label that outgrows a narrow shelf drops its group to the
    // next line instead of pushing the options off the edge.
    <span className={cn("flex flex-wrap items-center gap-2", className)}>
      <span className="whitespace-nowrap font-sans text-xs">{label}</span>
      <ToggleGroup
        aria-label={label}
        onValueChange={handleValueChange}
        size="sm"
        type="single"
        value={value}
        variant="outline"
      >
        {options.map((option) => (
          <ToggleGroupItem
            className="font-mono text-xs"
            key={option.value}
            value={option.value}
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </span>
  );
};
