/**
 * Character Spacing Mark Extension
 *
 * Handles: character spacing (w:spacing), position/raise-lower (w:position),
 * horizontal scale (w:w), and kerning (w:kern).
 *
 * Single mark with multiple attributes to avoid mark explosion.
 */

import { twipsToPixels, formatPx } from "../../../utils/units";
import { createMarkExtension } from "../create";

function halfPointsToPixels(halfPoints: number): number {
  return (halfPoints / 2) * (96 / 72);
}

export const CharacterSpacingExtension = createMarkExtension({
  name: "characterSpacing",
  schemaMarkName: "characterSpacing",
  markSpec: {
    attrs: {
      spacing: { default: null }, // twips
      position: { default: null }, // half-points (raise/lower)
      scale: { default: null }, // percentage
      kerning: { default: null }, // half-points
    },
    parseDOM: [
      {
        tag: "span.docx-char-spacing",
        getAttrs: (dom) => ({
          spacing: dom.dataset["spacing"]
            ? Number(dom.dataset["spacing"])
            : null,
          position: dom.dataset["position"]
            ? Number(dom.dataset["position"])
            : null,
          scale: dom.dataset["scale"] ? Number(dom.dataset["scale"]) : null,
          kerning: dom.dataset["kerning"]
            ? Number(dom.dataset["kerning"])
            : null,
        }),
      },
    ],
    toDOM(mark) {
      // SAFETY: CharacterSpacing attrs always match this shape per schema
      const spacing =
        typeof mark.attrs["spacing"] === "number"
          ? mark.attrs["spacing"]
          : null;
      const position =
        typeof mark.attrs["position"] === "number"
          ? mark.attrs["position"]
          : null;
      const scale =
        typeof mark.attrs["scale"] === "number" ? mark.attrs["scale"] : null;
      const kerning =
        typeof mark.attrs["kerning"] === "number"
          ? mark.attrs["kerning"]
          : null;

      const styles: string[] = [];
      const dataAttrs: Record<string, string> = {
        class: "docx-char-spacing",
      };

      if (spacing !== null && spacing !== 0) {
        styles.push(`letter-spacing: ${formatPx(twipsToPixels(spacing))}`);
        dataAttrs["data-spacing"] = String(spacing);
      }

      if (position !== null && position !== 0) {
        const px = halfPointsToPixels(position);
        styles.push(`vertical-align: ${formatPx(px)}`);
        dataAttrs["data-position"] = String(position);
      }

      if (scale !== null && scale !== 100) {
        styles.push(`transform: scaleX(${scale / 100})`);
        styles.push("display: inline-block");
        dataAttrs["data-scale"] = String(scale);
      }

      if (kerning !== null) {
        dataAttrs["data-kerning"] = String(kerning);
      }

      if (styles.length > 0) {
        dataAttrs["style"] = styles.join("; ");
      }

      return ["span", dataAttrs, 0];
    },
  },
});
