import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";

import { cn } from "../../lib/utils";
import type { FolioCheckboxProps } from "../folio-ui";

/**
 * Built-in, dependency-light Checkbox used when a consumer does not inject one.
 * Wraps `@base-ui/react`'s accessible Checkbox primitive with a minimal check
 * indicator; consumers inject their own design-system Checkbox for full polish.
 */
export function DefaultCheckbox({ className, ...props }: FolioCheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      className={cn("folio-default-checkbox", className)}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="folio-default-checkbox-indicator">
        <svg
          aria-hidden="true"
          fill="none"
          height="14"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="3"
          viewBox="0 0 24 24"
          width="14"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
        </svg>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
