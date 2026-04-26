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
          const sizeStr = value as string;
          const pxMatch = sizeStr.match(/^([\d.]+)px$/);
          if (pxMatch) {
            // SAFETY: capture group [1] always present when regex matches
            const px = Number.parseFloat(pxMatch[1]!);
            const pt = px * 0.75;
            return { size: Math.round(pt * 2) };
          }
          const ptMatch = sizeStr.match(/^([\d.]+)pt$/);
          if (ptMatch) {
            // SAFETY: capture group [1] always present when regex matches
            return { size: Math.round(Number.parseFloat(ptMatch[1]!) * 2) };
          }
          return false;
        },
      },
    ],
    toDOM(mark) {
      const size = mark.attrs["size"] as number;
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
    return {
      commands: {
        setFontSize: (size: number) =>
          setMark(ctx.schema.marks["fontSize"]!, { size }),
        clearFontSize: () => removeMark(ctx.schema.marks["fontSize"]!),
      },
    };
  },
});
