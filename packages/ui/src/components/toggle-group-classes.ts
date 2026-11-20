// The toggle group's and the segmented icon toggle's classes, with no React
// or Base UI: the group (./toggle-group.tsx) and the segmented toggle
// (./segmented-icon-toggle.tsx) are built from them, and a loading view draws
// the segmented toggle's face (./control-face.tsx) from the same classes, so
// the face and the control that replaces it share one box.

import { cn } from "../lib/utils";

/** The group's tray around its items. */
export const TOGGLE_GROUP_CLASS_NAME =
  "border-border/70 bg-muted/30 inline-flex w-fit shrink-0 items-center gap-0.5 rounded-lg border p-0.5 data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-stretch";

/** The chosen item: lifted onto the background, distinct from hover. */
export const TOGGLE_GROUP_ITEM_CLASS_NAME =
  "data-pressed:bg-background data-pressed:text-foreground";

/** A segmented icon toggle's sizes (./segmented-icon-toggle.tsx). */
export type SegmentedIconToggleSize = "compact" | "touch";

/** The segmented toggle's tray, over the group's. */
export const segmentedIconToggleClassName = (
  size: SegmentedIconToggleSize,
): string =>
  cn(
    "rounded-md",
    size === "touch" ? "h-7 [@media(any-pointer:coarse)]:h-12" : "h-7",
  );

/** One icon item of the segmented toggle, over an `icon-xs` muted button. */
export const segmentedIconToggleItemClassName = (
  size: SegmentedIconToggleSize,
): string =>
  cn(
    "h-6 w-7 rounded-sm sm:h-6",
    size === "touch" &&
      "[@media(any-pointer:coarse)]:h-11 [@media(any-pointer:coarse)]:w-11",
  );

/** The glyph inside a segmented toggle's item. */
export const SEGMENTED_ICON_TOGGLE_ICON_CLASS_NAME = "size-3.5";
