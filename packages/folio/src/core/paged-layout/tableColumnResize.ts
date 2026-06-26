/**
 * Resize a pair of adjacent column widths (in twips) as the boundary handle
 * between them is dragged by `deltaTwips`.
 *
 * For RTL (`w:bidiVisual`) tables the two columns either side of the boundary
 * are visually mirrored — the `left` column paints on the right — so the drag
 * delta is inverted: dragging the handle right grows the visual-left (logical
 * `right`) column and shrinks the visual-right (logical `left`) one, which also
 * keeps the committed boundary under the cursor. Returns the original widths
 * unchanged when either side would drop below `minWidth`.
 * eigenpal/docx-editor#940.
 */
export const resizeColumnPair = (
  left: number,
  right: number,
  deltaTwips: number,
  bidi: boolean,
  minWidth: number,
): { left: number; right: number } => {
  const signedDelta = bidi ? -deltaTwips : deltaTwips;
  const newLeft = left + signedDelta;
  const newRight = right - signedDelta;
  if (newLeft >= minWidth && newRight >= minWidth) {
    return { left: newLeft, right: newRight };
  }
  return { left, right };
};
