/** Room above the words for the bar, so it never covers what was selected. */
export const SELECTION_TOOLBAR_OFFSET_PX = 44;
/** The least the bar keeps between itself and any window edge. */
export const SELECTION_TOOLBAR_EDGE_MARGIN_PX = 8;

type AnchorRect = Pick<DOMRect, "left" | "top" | "width">;

/**
 * Where a bar floating over selected words goes, in viewport pixels: centred
 * on the selection and above it, then held inside the window. A selection
 * near the edge of a narrow pane would otherwise put half the bar off screen.
 * The bar's own width is known once it is on screen; until then (`barWidth`
 * 0) the centre stands, and the measure re-renders it into place. `left` is
 * the bar's centre: the bar translates itself back by half its width.
 */
export const selectionToolbarPosition = ({
  anchor,
  barWidth,
  viewportWidth,
}: {
  anchor: AnchorRect;
  barWidth: number;
  viewportWidth: number;
}): { left: number; top: number } => {
  const halfBar = barWidth / 2;
  const centred = anchor.left + anchor.width / 2;
  return {
    left: Math.max(
      SELECTION_TOOLBAR_EDGE_MARGIN_PX + halfBar,
      Math.min(
        centred,
        viewportWidth - SELECTION_TOOLBAR_EDGE_MARGIN_PX - halfBar,
      ),
    ),
    top: Math.max(
      SELECTION_TOOLBAR_EDGE_MARGIN_PX,
      anchor.top - SELECTION_TOOLBAR_OFFSET_PX,
    ),
  };
};
