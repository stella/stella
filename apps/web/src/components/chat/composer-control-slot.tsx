import type { ComponentProps } from "react";

import { cn } from "@stll/ui/utils";

/**
 * A round control's seat in the compact composer row: as tall as the row's
 * inner height, with the control centred in it. In a one-line row that
 * centres the control on the text; as the editor grows the row's `items-end`
 * keeps the seat on the last line, where the control stays centred on that
 * line. Every control in a compact row renders through this component; a
 * bare control would sink to the row's bottom edge, below the text's centre.
 */
export const ComposerControlSlot = ({
  className,
  ...props
}: ComponentProps<"span">) => (
  <span
    className={cn(
      "flex h-[calc(--spacing(11)-2px)] shrink-0 items-center",
      className,
    )}
    {...props}
  />
);
