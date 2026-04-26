/**
 * Highlight/Background Color Mark Extension
 */

import { resolveHighlightToCss } from "../../../utils/colorResolver";
import { createMarkExtension } from "../create";
import type { ExtensionContext, ExtensionRuntime } from "../types";
import { setMark, removeMark } from "./markUtils";

export const HighlightExtension = createMarkExtension({
  name: "highlight",
  schemaMarkName: "highlight",
  markSpec: {
    attrs: {
      color: { default: "yellow" },
    },
    parseDOM: [
      {
        tag: "mark",
      },
      {
        style: "background-color",
        getAttrs: (value) => {
          if (value && value !== "transparent" && value !== "inherit") {
            return { color: value };
          }
          return false;
        },
      },
    ],
    toDOM(mark) {
      const color = mark.attrs.color as string;
      // Resolve OOXML named highlight color (e.g., 'yellow' → '#FFFF00')
      const cssColor = resolveHighlightToCss(color);
      return ["mark", { style: `background-color: ${cssColor}` }, 0];
    },
  },
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
    return {
      commands: {
        setHighlight: (color: string) => {
          if (!color || color === "none") {
            return removeMark(ctx.schema.marks.highlight!);
          }
          return setMark(ctx.schema.marks.highlight!, { color });
        },
        clearHighlight: () => removeMark(ctx.schema.marks.highlight!),
      },
    };
  },
});
