/**
 * Converters between the model's run-level shading (`ShadingProperties`, from
 * `w:shd`) and the `runShading` ProseMirror mark's attrs. The mark carries the
 * shading FILL flattened as a ColorValue (mirroring the textColor mark) plus a
 * non-default pattern, so a custom run background survives the PM round-trip
 * (it was previously dropped on import) and re-serializes to `w:shd`.
 *
 * eigenpal #722 (#712) — folio models highlight as a strict OOXML named-palette
 * union, so arbitrary run backgrounds (Word/Google Docs `w:shd` fills) cannot be
 * represented as a highlight here; they round-trip as this dedicated mark.
 */

import type { ColorValue, ShadingProperties } from "../../types/colors";
import type { RunShadingAttrs } from "../schema/marks";

/**
 * Build the mark attrs for a run shading, or null when the shading has no
 * renderable/round-trippable fill (theme-less, `auto`, or fill-less). The
 * default `clear` pattern is the no-op carrier for a solid fill and is dropped:
 * absence re-serializes to `w:val="clear"` via the run serializer, and
 * `resolveShadingFill` only paints the fill when the pattern is not `clear`.
 */
export function shadingToRunShadingAttrs(
  shading: ShadingProperties | undefined,
): RunShadingAttrs | null {
  if (!shading) {
    return null;
  }
  // A `solid` pattern paints `w:color` over the whole cell, so the pattern
  // color (when present) is the visible background — not the fill. Flatten the
  // chosen color into the fill slot. Other patterns show the fill.
  const isSolid = shading.pattern === "solid";
  const fill = isSolid ? (shading.color ?? shading.fill) : shading.fill;
  if (!fill || fill.auto || (!fill.rgb && !fill.themeColor)) {
    return null;
  }

  const attrs: RunShadingAttrs = {};
  if (fill.rgb) {
    attrs.rgb = fill.rgb;
  }
  if (fill.themeColor) {
    attrs.themeColor = fill.themeColor;
  }
  if (fill.themeTint) {
    attrs.themeTint = fill.themeTint;
  }
  if (fill.themeShade) {
    attrs.themeShade = fill.themeShade;
  }
  // Carry a genuine pattern overlay for export fidelity, but not the default
  // `clear`/`nil`, nor the `solid` we just flattened into a plain fill. Keep the
  // pattern foreground color (`w:color`) too, so a pct*/stripe pattern's color
  // round-trips.
  if (
    !isSolid &&
    shading.pattern &&
    shading.pattern !== "clear" &&
    shading.pattern !== "nil"
  ) {
    attrs.pattern = shading.pattern;
    if (shading.color?.rgb) {
      attrs.patternColor = shading.color.rgb;
    }
  }
  return attrs;
}

/** Reconstruct the model shading (`w:shd` fill) from the mark attrs. */
export function runShadingAttrsToShading(
  attrs: RunShadingAttrs,
): ShadingProperties {
  const fill: ColorValue = {};
  if (attrs.rgb) {
    fill.rgb = attrs.rgb;
  }
  if (attrs.themeColor) {
    fill.themeColor = attrs.themeColor;
  }
  if (attrs.themeTint) {
    fill.themeTint = attrs.themeTint;
  }
  if (attrs.themeShade) {
    fill.themeShade = attrs.themeShade;
  }

  const shading: ShadingProperties = {};
  // Only attach a fill when at least one fill field survived; an empty `{}`
  // fill would resolve to a black background via `resolveShadingColor`.
  if (Object.keys(fill).length > 0) {
    shading.fill = fill;
  }
  if (attrs.pattern) {
    shading.pattern = attrs.pattern;
  }
  if (attrs.patternColor) {
    shading.color = { rgb: attrs.patternColor };
  }
  return shading;
}
