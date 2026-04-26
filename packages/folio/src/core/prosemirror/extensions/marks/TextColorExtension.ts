/**
 * Text Color Mark Extension
 */

import { textToStyle } from "../../../utils/formatToStyle";
import type { TextColorAttrs } from "../../schema/marks";
import { createMarkExtension } from "../create";
import type { ExtensionContext, ExtensionRuntime } from "../types";
import { setMark, removeMark } from "./markUtils";

export const TextColorExtension = createMarkExtension({
  name: "textColor",
  schemaMarkName: "textColor",
  markSpec: {
    attrs: {
      rgb: { default: null },
      themeColor: { default: null },
      themeTint: { default: null },
      themeShade: { default: null },
    },
    parseDOM: [
      {
        style: "color",
        getAttrs: (value) => {
          const colorValue = value as string;
          const hexMatch = colorValue.match(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})/);
          if (hexMatch) {
            // SAFETY: capture group [1] always present when regex matches
            return { rgb: hexMatch[1]!.toUpperCase() };
          }
          return false;
        },
      },
    ],
    toDOM(mark) {
      const attrs = mark.attrs as TextColorAttrs;
      const style = textToStyle({ color: attrs });
      const cssString = style.color ? `color: ${style.color}` : "";
      return ["span", { style: cssString }, 0];
    },
  },
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
    return {
      commands: {
        setTextColor: (attrs: TextColorAttrs) => {
          if (!attrs.rgb && !attrs.themeColor) {
            return removeMark(ctx.schema.marks.textColor!);
          }
          return setMark(
            ctx.schema.marks.textColor!,
            attrs as Record<string, unknown>,
          );
        },
        clearTextColor: () => removeMark(ctx.schema.marks.textColor!),
      },
    };
  },
});
