// eigenpal #722 (#712) — run-level shading (w:shd) as a background.
//
// Folio models `w:highlight` as a strict OOXML named-palette union, so an
// arbitrary run background (a Word/Google Docs `w:shd` fill, or a custom
// highlight another tool serialized as shading) cannot be carried as a
// highlight. This dedicated mark preserves the fill through the ProseMirror
// round-trip — it was previously parsed into `formatting.shading` but dropped
// at PM conversion, so the background silently vanished on reload — and lets
// the painter render it. It's populated from docx import and, on HTML paste,
// claims the `background-color` colors the highlight mark rejects (anything
// outside the OOXML named palette).

import { ensureHexPrefix } from "../../../utils/colorResolver";
import { expectRunShadingMarkAttrs } from "../../attrs";
import { createMarkExtension } from "../create";
import {
  normalizeCssColorKey,
  parseDOMHighlightColor,
} from "./HighlightExtension";

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
    parseDOM: [
      {
        style: "background-color",
        getAttrs: (value) => {
          // Defer to the highlight mark for any color it can map to the OOXML
          // named palette; claim the rest (arbitrary hex/rgb) as run shading so
          // pasted custom backgrounds aren't dropped.
          if (parseDOMHighlightColor(value)) {
            return false;
          }
          const hex = /^#([0-9a-fA-F]{6})$/u.exec(
            normalizeCssColorKey(value),
          )?.[1];
          return hex ? { rgb: hex.toUpperCase() } : false;
        },
      },
    ],
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
