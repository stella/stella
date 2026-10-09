import type { ComponentProps } from "react";

import { cn } from "@stll/ui/utils";

/**
 * How much room a box leaves around its content: a headnote reads as a
 * passage of its own, a provision card as a compact aside in the text.
 */
const INSET_DENSITY = {
  compact: "px-3 py-2",
  roomy: "px-5 py-4",
} as const;

/** Shared surface for headnotes and provision wording alongside decision text. */
export const ReaderInsetBox = ({
  className,
  density,
  ...props
}: ComponentProps<"div"> & { density: keyof typeof INSET_DENSITY }) => (
  <div
    className={cn(
      "bg-muted/30 border-border/50 rounded-lg border",
      INSET_DENSITY[density],
      className,
    )}
    {...props}
  />
);
