import type { InlineDropPosition } from "../lib/inline-reorder";
import { cn } from "../lib/utils";

/**
 * The bar beside a dragged-over item in a horizontal row. Render it inside
 * the item's positioned wrapper; `before`/`after` follow the text direction.
 */
export const InlineDropIndicator = ({
  position,
}: {
  position: InlineDropPosition | null;
}) =>
  position === null ? null : (
    <span
      aria-hidden="true"
      className={cn(
        "bg-primary pointer-events-none absolute inset-y-1 z-20 w-0.5 rounded-full",
        position === "before" ? "start-0" : "end-0",
      )}
    />
  );
