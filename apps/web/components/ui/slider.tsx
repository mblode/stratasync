"use client";

import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import type * as React from "react";
import { useCallback, useMemo } from "react";

import { cn } from "@/lib/utils";

type SliderProps = Omit<
  React.ComponentProps<typeof SliderPrimitive.Root>,
  "defaultValue" | "onValueChange" | "value"
> & {
  value?: number[];
  defaultValue?: number[];
  onValueChange?: (value: number[]) => void;
  showValue?: boolean;
  showOrigin?: boolean;
};

const Slider = ({
  className,
  defaultValue,
  onValueChange,
  value,
  min = 0,
  max = 100,
  showOrigin,
  showValue,
  ...props
}: SliderProps) => {
  const values = useMemo(() => {
    if (Array.isArray(value)) {
      return value;
    }
    if (Array.isArray(defaultValue)) {
      return defaultValue;
    }
    return [min, max];
  }, [value, defaultValue, min, max]);

  const handleValueChange = useCallback(
    (nextValue: number | readonly number[]) => {
      onValueChange?.(
        Array.isArray(nextValue) ? [...nextValue] : [nextValue as number]
      );
    },
    [onValueChange]
  );

  return (
    <SliderPrimitive.Root
      className={cn(
        "data-[orientation=vertical]:h-full data-[orientation=horizontal]:w-full",
        className
      )}
      data-slot="slider"
      defaultValue={defaultValue}
      max={max}
      min={min}
      onValueChange={handleValueChange}
      value={value}
      {...props}
    >
      <SliderPrimitive.Control className="relative flex h-[var(--field-height)] w-full cursor-grab touch-none select-none items-center data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col data-[disabled]:opacity-50">
        <SliderPrimitive.Track
          className="relative h-[12px] w-full grow overflow-hidden rounded-full bg-muted"
          data-slot="slider-track"
        >
          <SliderPrimitive.Indicator
            className="absolute h-full bg-primary"
            data-slot="slider-range"
          />
          {showOrigin && (
            <div className="pointer-events-none absolute top-1/2 left-1/2 h-[12px] w-[2px] -translate-x-1/2 -translate-y-1/2 bg-foreground/30" />
          )}
        </SliderPrimitive.Track>
        {Array.from({ length: values.length }, (_, index) => (
          <SliderPrimitive.Thumb
            className="block size-[28px] rounded-full border-[0.5px] border-border bg-white shadow-lg ring-offset-background transition-colors hover:border-input-hover focus:border-ring focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
            data-slot="slider-thumb"
            key={index}
          >
            {showValue && (
              <div className="absolute top-[36px] left-1/2 h-[32px] w-fit -translate-x-1/2 text-center text-foreground text-xs">
                {values[index]}
              </div>
            )}
          </SliderPrimitive.Thumb>
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
};

export { Slider };
