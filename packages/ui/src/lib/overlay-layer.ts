// Keep application chrome at or below 80, Search below the toast viewport at
// 90, and Search-owned portals above both. Named layers keep portal stacking
// coherent even though nested dialogs and popovers mount under document.body.
export const OVERLAY_LAYER_CLASS_NAMES = {
  default: "z-50",
  search: "z-[85]",
  "search-child": "z-[100]",
} as const;

export type OverlayLayer = keyof typeof OVERLAY_LAYER_CLASS_NAMES;
