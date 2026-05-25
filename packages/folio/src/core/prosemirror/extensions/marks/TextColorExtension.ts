/**
 * Text Color Mark Extension
 */

import { panic } from "better-result";

import { textToStyle } from "../../../utils/formatToStyle";
import { expectTextColorMarkAttrs } from "../../attrs";
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
          const hexMatch = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})/u.exec(value);
          if (hexMatch) {
            // SAFETY: capture group [1] always present when regex matches
            return { rgb: (hexMatch[1] ?? "").toUpperCase() };
          }
          return false;
        },
      },
    ],
    toDOM(mark) {
      const colorAttrs = expectTextColorMarkAttrs(mark);
      const style = textToStyle({ color: colorAttrs });
      const cssColor: unknown = style.color;
      const cssString =
        typeof cssColor === "string" && cssColor ? `color: ${cssColor}` : "";
      return ["span", { style: cssString }, 0];
    },
  },
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
    const textColorType = ctx.schema.marks["textColor"];
    if (!textColorType) {
      panic("Missing mark type: textColor");
    }
    return {
      commands: {
        setTextColor: (attrs: TextColorAttrs) => {
          if (!attrs.rgb && !attrs.themeColor) {
            return removeMark(textColorType);
          }
          return setMark(textColorType, attrs as Record<string, unknown>);
        },
        clearTextColor: () => removeMark(textColorType),
      },
    };
  },
});
