/**
 * Underline Mark Extension
 */

import { panic } from "better-result";
import { toggleMark } from "prosemirror-commands";

import type { TextColorAttrs } from "../../schema/marks";
import { createMarkExtension } from "../create";
import type { ExtensionContext, ExtensionRuntime } from "../types";
import { setMark } from "./markUtils";

export const UnderlineExtension = createMarkExtension({
  name: "underline",
  schemaMarkName: "underline",
  markSpec: {
    attrs: {
      style: { default: "single" },
      color: { default: null },
    },
    parseDOM: [
      { tag: "u" },
      {
        style: "text-decoration",
        getAttrs: (value) => (value.includes("underline") ? {} : false),
      },
    ],
    toDOM(mark) {
      // SAFETY: underline mark attrs always match UnderlineAttrs shape per schema
      const style =
        typeof mark.attrs["style"] === "string"
          ? mark.attrs["style"]
          : undefined;
      // Access color.rgb via Reflect.get to avoid unsafe-type-assertion on `any`
      const colorObj: unknown = Reflect.get(mark.attrs, "color");
      const colorRgb: unknown =
        typeof colorObj === "object" && colorObj !== null
          ? Reflect.get(colorObj, "rgb")
          : undefined;
      const cssStyle: string[] = ["text-decoration: underline"];

      if (style && style !== "single") {
        const styleMap: Record<string, string> = {
          double: "double",
          dotted: "dotted",
          dash: "dashed",
          wave: "wavy",
        };
        const cssDecorationStyle = styleMap[style];
        if (cssDecorationStyle) {
          cssStyle.push(`text-decoration-style: ${cssDecorationStyle}`);
        }
      }

      if (typeof colorRgb === "string" && colorRgb) {
        cssStyle.push(`text-decoration-color: #${colorRgb}`);
      }

      return ["span", { style: cssStyle.join("; ") }, 0];
    },
  },
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
    const underlineType = ctx.schema.marks["underline"];
    if (!underlineType) {
      panic("Missing mark type: underline");
    }
    return {
      commands: {
        toggleUnderline: () => toggleMark(underlineType),
        setUnderlineStyle: (style: string, color?: TextColorAttrs) =>
          setMark(underlineType, { style, color }),
      },
      keyboardShortcuts: {
        "Mod-u": toggleMark(underlineType),
      },
    };
  },
});
