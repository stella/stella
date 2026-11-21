import { cn } from "@stll/ui/utils";

/**
 * The one size scale every chip draws with: the attachment chips of each
 * composer (pasted or quoted text, a file, an image, a slash command) and the
 * reference pills (a case, a document, an entity, a skill). A chip kind picks
 * its icon and label and never its own height, so a quotation sits at the
 * same size as the screenshot or case number beside it.
 */
// Coarse pointers keep a 44px control plus the shell border clear of adjacent rows.
export const CHIP_HEIGHT_CLASS = "h-5 pointer-coarse:h-12";

export const CHIP_ICON_CLASS = "size-3 shrink-0";

export const CHIP_TOUCH_TARGET_CLASS =
  "pointer-coarse:min-h-11 pointer-coarse:min-w-11";

/** An action inside a chip (expand, remove) fits within the chip's height. */
export const CHIP_ACTION_CLASS = cn(
  "hover:bg-accent focus-visible:outline-ring inline-flex size-4 shrink-0 items-center justify-center rounded-sm focus-visible:outline-2",
  CHIP_TOUCH_TARGET_CLASS,
);
