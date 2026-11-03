import type { ComponentProps } from "react";

import type { ControlSize } from "../lib/control-size";
import { NativeField } from "./input.native";

/** The web textarea's box at each control size: its border and inset. */
const BOX = {
  sm: "min-h-16 rounded-lg border border-input bg-card px-2.5 py-1.5",
  default: "min-h-20 rounded-lg border border-input bg-card px-3 py-2",
  lg: "min-h-22 rounded-lg border border-input bg-card px-3 py-2.5",
} as const satisfies Record<ControlSize, string>;

/** Unboxed text sits on the container's own line height. */
const UNSTYLED_BOX = {
  sm: "p-0 leading-5",
  default: "p-0",
  lg: "p-0",
} as const satisfies Record<ControlSize, string>;

/**
 * The web's `Textarea` (./textarea.tsx) on a phone: text that wraps and grows,
 * in the web's box, or none for a field inside a container that draws one
 * (the composer).
 */
export const Textarea = ({
  size = "default",
  unstyled = false,
  ...props
}: Omit<ComponentProps<typeof NativeField>, "box" | "multiline">) => (
  <NativeField
    {...props}
    box={unstyled ? UNSTYLED_BOX[size] : BOX[size]}
    multiline
    size={size}
  />
);
