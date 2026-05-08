/**
 * Run formatting override mark.
 *
 * OOXML can explicitly turn inherited boolean/defaultable run properties off
 * (for example <w:b w:val="0"/>). Plain PM marks cannot distinguish "inherit"
 * from "explicitly off", so this mark carries those negative overrides.
 */

import type { Mark } from "prosemirror-model";

import type { TextFormatting } from "../../../types/document";
import { createMarkExtension } from "../create";

type RunFormattingOverrideAttrs = Record<string, false | "none">;

export function buildRunFormattingOverrideAttrs(
  formatting: TextFormatting | undefined,
): RunFormattingOverrideAttrs | undefined {
  if (!formatting) {
    return undefined;
  }

  const attrs: RunFormattingOverrideAttrs = {};

  if (formatting.bold === false) {
    attrs["bold"] = false;
  }
  if (formatting.italic === false) {
    attrs["italic"] = false;
  }
  if (formatting.underline?.style === "none") {
    attrs["underline"] = "none";
  }
  if (formatting.strike === false) {
    attrs["strike"] = false;
  }
  if (formatting.doubleStrike === false) {
    attrs["doubleStrike"] = false;
  }
  if (formatting.allCaps === false) {
    attrs["allCaps"] = false;
  }
  if (formatting.smallCaps === false) {
    attrs["smallCaps"] = false;
  }
  if (formatting.hidden === false) {
    attrs["hidden"] = false;
  }
  if (formatting.emboss === false) {
    attrs["emboss"] = false;
  }
  if (formatting.imprint === false) {
    attrs["imprint"] = false;
  }
  if (formatting.shadow === false) {
    attrs["shadow"] = false;
  }
  if (formatting.outline === false) {
    attrs["outline"] = false;
  }

  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

export function applyRunFormattingOverrideMark(
  formatting: TextFormatting,
  mark: Mark,
): void {
  if (mark.attrs["bold"] === false) {
    formatting.bold = false;
  }
  if (mark.attrs["italic"] === false) {
    formatting.italic = false;
  }
  if (mark.attrs["underline"] === "none") {
    formatting.underline = { style: "none" };
  }
  if (mark.attrs["strike"] === false) {
    formatting.strike = false;
  }
  if (mark.attrs["doubleStrike"] === false) {
    formatting.doubleStrike = false;
  }
  if (mark.attrs["allCaps"] === false) {
    formatting.allCaps = false;
  }
  if (mark.attrs["smallCaps"] === false) {
    formatting.smallCaps = false;
  }
  if (mark.attrs["hidden"] === false) {
    formatting.hidden = false;
  }
  if (mark.attrs["emboss"] === false) {
    formatting.emboss = false;
  }
  if (mark.attrs["imprint"] === false) {
    formatting.imprint = false;
  }
  if (mark.attrs["shadow"] === false) {
    formatting.shadow = false;
  }
  if (mark.attrs["outline"] === false) {
    formatting.outline = false;
  }
}

export const RunFormattingOverrideExtension = createMarkExtension({
  name: "runFormattingOverride",
  schemaMarkName: "runFormattingOverride",
  markSpec: {
    attrs: {
      bold: { default: null },
      italic: { default: null },
      underline: { default: null },
      strike: { default: null },
      doubleStrike: { default: null },
      allCaps: { default: null },
      smallCaps: { default: null },
      hidden: { default: null },
      emboss: { default: null },
      imprint: { default: null },
      shadow: { default: null },
      outline: { default: null },
    },
    toDOM(mark) {
      const styles: string[] = [];

      if (mark.attrs["bold"] === false) {
        styles.push("font-weight: normal");
      }
      if (mark.attrs["italic"] === false) {
        styles.push("font-style: normal");
      }
      if (
        mark.attrs["underline"] === "none" ||
        mark.attrs["strike"] === false
      ) {
        styles.push("text-decoration: none");
      }
      if (mark.attrs["allCaps"] === false) {
        styles.push("text-transform: none");
      }
      if (mark.attrs["smallCaps"] === false) {
        styles.push("font-variant-caps: normal");
      }
      if (mark.attrs["hidden"] === false) {
        styles.push("visibility: visible");
      }

      return ["span", styles.length > 0 ? { style: styles.join("; ") } : {}, 0];
    },
  },
});
