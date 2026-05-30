/**
 * Wrap-type predicates shared across the layout pipeline.
 *
 * Mirrors eigenpal docx-editor `wrapTypes` so that the new textBoxFlow
 * predicates (eigenpal #474) and the existing image classifiers agree on
 * which OOXML wrap variants are floating, which paint over body text, and
 * which wrap around it.
 */

const FLOATING_WRAP_TYPES = new Set([
  "square",
  "tight",
  "through",
  "topAndBottom",
  "behind",
  "inFront",
]);

const TEXT_WRAPPING_TYPES = new Set(["square", "tight", "through"]);

/**
 * `true` for any wrap type that takes the object out of inline flow.
 * Includes `topAndBottom` and the wrapNone variants (`behind`/`inFront`):
 * those are anchored at absolute coordinates even though they don't shrink
 * line widths.
 */
export function isFloatingWrapType(wrapType: string | undefined): boolean {
  return wrapType !== undefined && FLOATING_WRAP_TYPES.has(wrapType);
}

/**
 * `true` for `behind` and `inFront` — wrapNone variants that don't shrink
 * line widths; text paints over or under the object.
 */
export function isWrapNone(wrapType: string | undefined): boolean {
  return wrapType === "behind" || wrapType === "inFront";
}

/**
 * `true` for wrap types that actually divert lines around the object
 * (`square` / `tight` / `through`). Excludes `topAndBottom` (block flow)
 * and the wrapNone variants.
 */
export function wrapsAroundText(wrapType: string | undefined): boolean {
  return wrapType !== undefined && TEXT_WRAPPING_TYPES.has(wrapType);
}
