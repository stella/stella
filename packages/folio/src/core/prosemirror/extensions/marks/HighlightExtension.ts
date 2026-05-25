/**
 * Highlight/Background Color Mark Extension
 */

import { panic } from "better-result";

import { resolveHighlightToCss } from "../../../utils/colorResolver";
import { expectHighlightMarkAttrs } from "../../attrs";
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
      const { color } = expectHighlightMarkAttrs(mark);
      // Resolve OOXML named highlight color (e.g., 'yellow' → '#FFFF00')
      const cssColor = resolveHighlightToCss(color);
      return ["mark", { style: `background-color: ${cssColor}` }, 0];
    },
  },
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
    const highlightType = ctx.schema.marks["highlight"];
    if (!highlightType) {
      panic("Missing mark type: highlight");
    }
    return {
      commands: {
        setHighlight: (color: string) => {
          if (!color || color === "none") {
            return removeMark(highlightType);
          }
          return setMark(highlightType, { color });
        },
        clearHighlight: () => removeMark(highlightType),
      },
    };
  },
});
