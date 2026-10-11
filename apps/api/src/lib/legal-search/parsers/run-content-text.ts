import { panic } from "better-result";

import { isOoxmlSymbolCharacter, type RunContent } from "@stll/docx-core/model";

/** Visible characters only; note anchors and field instructions have separate owners. */
export const runContentVisibleText = (item: RunContent): string => {
  switch (item.type) {
    case "text":
    case "preservedXml":
      return item.text;
    case "tab":
      return "\t";
    case "break":
      return "\n";
    case "noBreakHyphen":
      return "\u2011";
    case "symbol":
      // Match Folio's visible/markdown projection of the authored symbol code.
      return isOoxmlSymbolCharacter(item.char)
        ? String.fromCodePoint(Number.parseInt(item.char, 16))
        : item.char;
    case "softHyphen":
    case "footnoteRef":
    case "endnoteRef":
    case "noteMarker":
    case "fieldChar":
    case "instrText":
    case "renderedPageBreak":
    case "drawing":
    case "shape":
      return "";
    default:
      item satisfies never;
      return panic("Unhandled document run content");
  }
};
