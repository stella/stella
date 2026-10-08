import type { ComponentProps } from "react";

import { cn } from "@stll/ui/utils";

/** Shared surface for headnotes and provision wording alongside decision text. */
export const ReaderInsetBox = ({
  className,
  ...props
}: ComponentProps<"div">) => (
  <div
    className={cn(
      "bg-muted/30 border-border/50 rounded-lg border px-5 py-4",
      className,
    )}
    {...props}
  />
);
