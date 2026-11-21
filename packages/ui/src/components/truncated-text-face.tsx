import type { ComponentProps } from "react";

import { cn } from "../lib/utils";

/**
 * How many lines the text may take before it is cut; `"none"` lets it take
 * as many as it needs, for text that is cut only in some states (collapsed,
 * compact) and shown whole in the others.
 */
type TruncatedTextLines = 1 | 2 | 3 | 4 | 5 | 6 | 8 | "none";

/**
 * `max-w-full` caps the text at its container even where the container does
 * not stretch it (a flex column with `items-start`, an inline-block): without
 * it a nowrap line sizes to its whole text and runs past the container.
 */
const TRUNCATED_TEXT_LINES_CLASS = {
  1: "block min-w-0 max-w-full truncate",
  2: "line-clamp-2 min-w-0 max-w-full wrap-anywhere",
  3: "line-clamp-3 min-w-0 max-w-full wrap-anywhere",
  4: "line-clamp-4 min-w-0 max-w-full wrap-anywhere",
  5: "line-clamp-5 min-w-0 max-w-full wrap-anywhere",
  6: "line-clamp-6 min-w-0 max-w-full wrap-anywhere",
  8: "line-clamp-8 min-w-0 max-w-full wrap-anywhere",
  none: "min-w-0 max-w-full",
} as const satisfies Record<TruncatedTextLines, string>;

type TruncatedTextFaceProps = ComponentProps<"span"> & {
  lines?: TruncatedTextLines;
};

/**
 * Cut text's face: the box `TruncatedText` draws, without the hint that shows
 * the whole text, for a loading view drawn before the page mounts. It imports
 * no tooltip or popover, so a view the server paints before the providers
 * mount can draw one, and the text that replaces it lands in the same box.
 */
const TruncatedTextFace = ({
  className,
  lines = 1,
  ...props
}: TruncatedTextFaceProps) => (
  <span
    className={cn(TRUNCATED_TEXT_LINES_CLASS[lines], className)}
    data-slot="truncated-text"
    {...props}
  />
);

export { TRUNCATED_TEXT_LINES_CLASS, TruncatedTextFace };
export type { TruncatedTextFaceProps, TruncatedTextLines };
