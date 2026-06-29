import { Input as InputPrimitive } from "@base-ui/react/input";

import { cn } from "../../lib/utils";
import type { FolioInputProps } from "../folio-ui";

/**
 * Built-in, dependency-light Input used when a consumer does not inject one.
 *
 * Wraps `@base-ui/react`'s Input primitive, honoring the `nativeInput` escape
 * hatch (render a plain `<input>` when the caller needs uncontrolled native
 * behavior) and folio's `size` shorthand. Styling is intentionally minimal;
 * consumers inject their own design-system Input for full polish.
 */
export function DefaultInput({
  className,
  size = "default",
  nativeInput = false,
  ...props
}: FolioInputProps) {
  const inputClassName = cn("folio-default-input", className);
  const numericSize = typeof size === "number" ? size : undefined;

  if (nativeInput) {
    return (
      <input
        className={inputClassName}
        data-size={typeof size === "string" ? size : undefined}
        size={numericSize}
        {...props}
      />
    );
  }

  return (
    <InputPrimitive
      className={inputClassName}
      data-size={typeof size === "string" ? size : undefined}
      size={numericSize}
      {...props}
    />
  );
}
