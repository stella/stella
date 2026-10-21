import type * as React from "react";

import { cn } from "../lib/utils";

/** A readable measure for narrative copy; task-shaped text should not use it. */
export const Prose = ({ className, ...props }: React.ComponentProps<"p">) => (
  <p className={cn("max-w-[80ch] leading-relaxed", className)} {...props} />
);
