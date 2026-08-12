import type * as React from "react";

/**
 * Whether a tooltip value would actually render a popup.
 *
 * Single source of truth for "there is a tooltip": `renderTooltipTrigger`
 * decides whether to mount one, and `resolveButtonDisposition` decides whether
 * a disabled button has to stay hoverable so that popup can open. Two copies of
 * this predicate would drift into a button that suppresses its own tooltip.
 */
export const hasTooltipContent = (content: React.ReactNode): boolean =>
  content !== undefined &&
  content !== null &&
  content !== "" &&
  content !== false;
