// The sort chips' boxes, as the classes and button sizes each part is built
// from: the chips (./sorts.tsx) and their faces (./sorts-face.tsx) read them
// here, so a face and the chip that replaces it share one box.

/** The bordered pill around one sort's toggle and its remove button. */
export const SORT_CHIP_CLASS =
  "bg-muted/50 flex items-center rounded-md border";

/** The part that names the sort and flips its direction. */
export const SORT_CHIP_TOGGLE = { size: "xs", variant: "ghost" } as const;

/** A glyph-only button: the chip's remove, and "add a sort". */
export const SORT_ICON_BUTTON = { size: "icon-xs", variant: "ghost" } as const;

/** The direction's words beside the property's name. */
export const SORT_DIRECTION_CLASS = "text-muted-foreground";
