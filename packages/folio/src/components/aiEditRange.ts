/**
 * Helpers shared by the AI-edit imperative API methods.
 *
 * Lives outside `DocxEditor.tsx` so the bounds-checking logic that protects
 * `TextSelection.between` from "endpoint not pointing into a node with
 * inline content" can be unit-tested without spinning up a real PM view.
 */

export type DocPositionRange = { from: number; to: number };

/**
 * Clamp a `{from, to}` pair so both endpoints fit inside a document of
 * `docSize` (in PM content positions). Block-boundary snapshots and stale
 * range data sometimes produce a `to` one past the last inline position;
 * `view.state.doc.resolve(...)` rejects that with
 * "Position … out of range", and `TextSelection.between` doesn't help — it
 * needs *valid* resolved positions. Clamping before resolution is the cheap
 * defensive step.
 *
 * Order is preserved: if both endpoints exceed `docSize`, the returned
 * `from` may equal `to`, yielding a cursor selection at the doc end.
 */
export function clampRangeToDocSize(
  docSize: number,
  range: DocPositionRange,
): DocPositionRange {
  return {
    from: Math.min(Math.max(range.from, 0), docSize),
    to: Math.min(Math.max(range.to, 0), docSize),
  };
}
