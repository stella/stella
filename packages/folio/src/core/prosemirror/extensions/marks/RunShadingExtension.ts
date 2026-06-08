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

import { ensureHexPrefix } from "../../../utils/colorResolver";
import { expectRunShadingMarkAttrs } from "../../attrs";
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
      const { rgb } = expectRunShadingMarkAttrs(mark);
      // The editable overlay has no theme. Use the concrete rgb fill directly:
      // `resolveColor` prefers a theme slot when both are present, which here
      // (theme=null) resolves to the Office default (often black). Theme-only
      // fills carry no rgb and are left to the paged painter, which has the
      // real theme. (#722)
      const background = rgb ? ensureHexPrefix(rgb) : "";
      return [
        "span",
        background ? { style: `background-color: ${background}` } : {},
        0,
      ];
    },
  },
});
