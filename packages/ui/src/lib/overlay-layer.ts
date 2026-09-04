// One ladder for every portalled or floating surface. Nested dialogs, popovers
// and menus all mount under document.body, so a literal `z-[80]` invented at a
// call site silently outranks whatever it was never compared against — name the
// band here instead.
//
// Ascending, and the order is the rule: floating pane chrome (the docked
// composer and its veil) is NOT modal, so anything with a dimming backdrop has
// to cover it. Dialogs sat at z-50 and lost that argument, which left the
// composer painted on top of a dimmed template-check dialog.
export const BOARD_DRAG_OVERLAY_Z_INDEX = 75;

/**
 * The shell's own sticky chrome: its top bar, and anything else the shell pins
 * around a view.
 *
 * Not part of the ladder below, which is for portalled surfaces: this one
 * stays in flow, so it only ever competes with the sticky chrome a view paints
 * inside the shell's scroller. A kanban board pins its header at z-20 and a
 * lane's row at z-10, and when the shell's content column (not the board) is
 * the scroll container the two tie and paint order decides which one wins.
 * Stated one step above that, and far below every portalled surface here,
 * which must still cover the shell.
 */
export const SHELL_CHROME_LAYER_CLASS_NAME = "z-30";

export const OVERLAY_LAYER_CLASS_NAMES = {
  /** Docked composer, suggestion chips, and other in-pane floating chrome. */
  chrome: "z-[80]",
  /** Dialogs, sheets, popovers, tooltips: above chrome, below toasts. */
  default: "z-[85]",
  /** Search sits a hair above a plain dialog so its own popup wins. */
  search: "z-[86]",
  /**
   * Transient popups — menu, select, combobox, context menus. Above everything
   * including the toast viewport (z-[90]), because any of them can be opened
   * *from* a dialog, a popover or a toast action and must cover its opener.
   * They sat at z-50 alongside dialogs, so which one won was decided by portal
   * mount order: a select inside a filter popover rendered behind it.
   */
  popup: "z-[100]",
  /** Historical alias for `popup`; Search's own menus use the same band. */
  "search-child": "z-[100]",
} as const;

export type OverlayLayer = keyof typeof OVERLAY_LAYER_CLASS_NAMES;

/**
 * Gap kept between a collision-shifted floating surface and its boundary, in
 * pixels. Base UI's 5px default puts the popup shadow flush against the
 * viewport edge once `shift()` has to move a popup that is wider than its
 * anchor, which reads as a clipped surface rather than a repositioned one.
 */
export const OVERLAY_COLLISION_PADDING = 8;
