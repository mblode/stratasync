"use client";

import { Checkbox } from "@/components/ui/checkbox.js";

const CheckboxWithText = () => (
  <div className="flex items-start gap-3">
    <Checkbox id="terms" />
    <div className="grid gap-1.5 leading-none">
      <label
        className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
        htmlFor="terms"
      >
        Accept terms and conditions
      </label>
      <p className="text-sm text-muted-foreground">
        You agree to our Terms of Service and Privacy Policy.
      </p>
    </div>
  </div>
);

export { CheckboxWithText };
