/**
 * The one size scale every chip draws with: the attachment chips of each
 * composer (pasted or quoted text, a file, an image, a slash command) and the
 * reference pills (a case, a document, an entity, a skill). A chip kind picks
 * its icon and label and never its own height, so a quotation sits at the
 * same size as the screenshot or case number beside it.
 */
export const CHIP_HEIGHT_CLASS = "h-5";

export const CHIP_ICON_CLASS = "size-3 shrink-0";

/** An action inside a chip (expand, remove) fits within the chip's height. */
export const CHIP_ACTION_CLASS =
  "hover:bg-accent focus-visible:outline-ring inline-flex size-4 shrink-0 items-center justify-center rounded-sm focus-visible:outline-2";
