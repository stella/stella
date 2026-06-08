// eigenpal #722 (#712) — run-level shading (w:shd) as a background.
//
// Folio models `w:highlight` as a strict OOXML named-palette union, so an
// arbitrary run background (a Word/Google Docs `w:shd` fill, or a custom
// highlight another tool serialized as shading) cannot be carried as a
// highlight. This dedicated mark preserves the fill through the ProseMirror
// round-trip — it was previously parsed into `formatting.shading` but dropped
// at PM conversion, so the background silently vanished on reload — and lets
// the painter render it. No parseDOM: the highlight mark already claims
// `background-color` on HTML paste; this mark is populated from docx import.

import { resolveShadingFill } from "../../../utils/formatToStyle";
import { expectRunShadingMarkAttrs } from "../../attrs";
import { runShadingAttrsToShading } from "../../conversion/runShadingMark";
import { createMarkExtension } from "../create";

export const RunShadingExtension = createMarkExtension({
  name: "runShading",
  schemaMarkName: "runShading",
  markSpec: {
    attrs: {
      rgb: { default: null },
      themeColor: { default: null },
      themeTint: { default: null },
      themeShade: { default: null },
      pattern: { default: null },
    },
    toDOM(mark) {
      const attrs = expectRunShadingMarkAttrs(mark);
      // The editable overlay has no theme, so only a concrete rgb fill is
      // paintable here. Theme-only fills are left to the paged painter (which
      // has the real theme) rather than guessing the Office default — without
      // the rgb guard, `resolveShadingFill(_, null)` would resolve a theme slot
      // to its default colour (often black). A clear/absent pattern paints the
      // fill solid. (#722)
      const background = attrs.rgb
        ? resolveShadingFill(runShadingAttrsToShading(attrs), null)
        : "";
      return [
        "span",
        background ? { style: `background-color: ${background}` } : {},
        0,
      ];
    },
  },
});
