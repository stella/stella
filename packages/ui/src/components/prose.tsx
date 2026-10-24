import type * as React from "react";

import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils";

const proseVariants = cva("max-w-[80ch] leading-relaxed", {
  defaultVariants: { size: "default", tone: "default" },
  variants: {
    size: {
      default: "",
      /** Supporting copy under a heading or inside a card. */
      sm: "text-sm leading-6 text-pretty",
      /** A page lede: small on phones, body size from `sm` up. */
      lede: "text-sm leading-6 text-pretty sm:text-base",
    },
    tone: {
      default: "",
      /** Secondary narrative that sits beside a primary line. */
      muted: "text-muted-foreground",
    },
  },
});

/** A readable measure for narrative copy; task-shaped text should not use it. */
export const Prose = ({
  className,
  size,
  tone,
  ...props
}: React.ComponentProps<"p"> & VariantProps<typeof proseVariants>) => (
  <p className={cn(proseVariants({ size, tone }), className)} {...props} />
);
