/**
 * Position the table insert ("+") button inside the zoom-scaled viewport.
 *
 * The button is an absolute child of `.paged-editor__viewport`, which carries
 * `transform: scale(zoom)`. `getBoundingClientRect` returns already-scaled
 * screen pixels, so the screen-space delta from the viewport origin must be
 * divided by `zoom` to land in the viewport's own coordinate space. The
 * constant nudge then stays in that (button-local) space so it tracks the
 * button, which is scaled too. Without the divisor the button drifts off the
 * table edge at any zoom other than 100% (eigenpal/docx-editor#934).
 */
export const tableInsertButtonOffset = (
  edge: number,
  viewportEdge: number,
  zoom: number,
  nudge: number,
): number => (edge - viewportEdge) / (zoom || 1) - nudge;
