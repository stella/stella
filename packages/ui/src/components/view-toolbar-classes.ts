// The view toolbar's filter controls, as the size, variant and classes of
// the button each one is: the controls (./view-toolbar.tsx) and their faces
// (./view-toolbar-shell.tsx) read them here, so the two share one box.

/** The bare "add a filter" button, a glyph alone. */
export const VIEW_FILTER_BUTTON = {
  size: "icon-xs",
  variant: "ghost",
} as const;

/** The glyph on the "add a filter" button. */
export const VIEW_FILTER_ICON_CLASS_NAME = "size-3.5";

/** A filter's chip: its field, the operator and the value. */
export const VIEW_FILTER_CHIP = {
  className: "gap-1.5 font-normal",
  size: "xs",
  variant: "secondary",
} as const;
