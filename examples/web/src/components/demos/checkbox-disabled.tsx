"use client";

import { Checkbox } from "@/components/ui/checkbox.js";

const CheckboxDisabled = () => (
  <div className="flex items-center gap-3">
    <Checkbox id="disabled" disabled />
    <label
      className="text-sm font-medium leading-none text-muted-foreground"
      htmlFor="disabled"
    >
      Disabled
    </label>
  </div>
);

export { CheckboxDisabled };
