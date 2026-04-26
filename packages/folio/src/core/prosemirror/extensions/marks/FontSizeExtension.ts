/**
 * Font Size Mark Extension
 */

import { createMarkExtension } from "../create";
import type { ExtensionContext, ExtensionRuntime } from "../types";
import { setMark, removeMark } from "./markUtils";

export const FontSizeExtension = createMarkExtension({
  name: "fontSize",
  schemaMarkName: "fontSize",
  markSpec: {
    attrs: {
      size: { default: 24 },
    },
    parseDOM: [
      {
        style: "font-size",
        getAttrs: (value) => {
          const pxMatch = /^([\d.]+)px$/.exec(value);
          if (pxMatch) {
            // SAFETY: capture group [1] always present when regex matches
            const px = Number.parseFloat(pxMatch[1] ?? "0");
            const pt = px * 0.75;
            return { size: Math.round(pt * 2) };
          }
          const ptMatch = /^([\d.]+)pt$/.exec(value);
          if (ptMatch) {
            // SAFETY: capture group [1] always present when regex matches
            return {
              size: Math.round(Number.parseFloat(ptMatch[1] ?? "0") * 2),
            };
          }
          return false;
        },
      },
    ],
    toDOM(mark) {
      // SAFETY: mark.attrs.size is always a number per the attrs spec above
      const size = Number(mark.attrs["size"]);
      const pt = size / 2;
      const lineHeight = (pt * 1.15).toFixed(2);
      return [
        "span",
        { style: `font-size: ${pt}pt; line-height: ${lineHeight}pt` },
        0,
      ];
    },
  },
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
    const fontSizeType = ctx.schema.marks["fontSize"];
    if (!fontSizeType) {
      throw new Error("Missing mark type: fontSize");
    }
    return {
      commands: {
        setFontSize: (size: number) => setMark(fontSizeType, { size }),
        clearFontSize: () => removeMark(fontSizeType),
      },
    };
  },
});
