/**
 * Font Family Mark Extension
 */

import { panic } from "better-result";

import { createMarkExtension } from "../create";
import type { ExtensionContext, ExtensionRuntime } from "../types";
import { setMark, removeMark } from "./markUtils";

export const FontFamilyExtension = createMarkExtension({
  name: "fontFamily",
  schemaMarkName: "fontFamily",
  markSpec: {
    attrs: {
      ascii: { default: null },
      hAnsi: { default: null },
      eastAsia: { default: null },
      cs: { default: null },
      asciiTheme: { default: null },
      hAnsiTheme: { default: null },
      eastAsiaTheme: { default: null },
      csTheme: { default: null },
    },
    parseDOM: [
      {
        style: "font-family",
        getAttrs: (value) => {
          // SAFETY: split always returns at least one element
          const firstFont = (value.split(",")[0] ?? "")
            .trim()
            .replace(/['"]/gu, "");
          if (firstFont) {
            return { ascii: firstFont };
          }
          return false;
        },
      },
    ],
    toDOM(mark) {
      // SAFETY: fontFamily mark attrs always have ascii/hAnsi per schema
      const ascii =
        typeof mark.attrs["ascii"] === "string"
          ? mark.attrs["ascii"]
          : undefined;
      const hAnsi =
        typeof mark.attrs["hAnsi"] === "string"
          ? mark.attrs["hAnsi"]
          : undefined;
      const fontName = ascii ?? hAnsi;
      if (!fontName) {
        return ["span", 0];
      }
      const quotedFont = fontName.includes(" ") ? `"${fontName}"` : fontName;
      return ["span", { style: `font-family: ${quotedFont}, sans-serif` }, 0];
    },
  },
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
    const fontFamilyType = ctx.schema.marks["fontFamily"];
    if (!fontFamilyType) {
      panic("Missing mark type: fontFamily");
    }
    return {
      commands: {
        setFontFamily: (fontName: string) =>
          setMark(fontFamilyType, {
            ascii: fontName,
            hAnsi: fontName,
          }),
        clearFontFamily: () => removeMark(fontFamilyType),
      },
    };
  },
});
