import type { SelectionState } from "../core/prosemirror";
import type { SelectionFormatting } from "./toolbarPrimitives";
import type { ListState } from "./ui/ListButtons";

type ParagraphNumPr = NonNullable<
  SelectionState["paragraphFormatting"]["numPr"]
>;

/**
 * Compute the toolbar list state from a paragraph's `numPr`. The legacy
 * convention treats `numId === 1` as bullets and any other `numId` as
 * numbered. Returns `undefined` when the paragraph is not in a list.
 */
export function extractListState(
  numPr: ParagraphNumPr | undefined,
): ListState | undefined {
  if (!numPr) {
    return undefined;
  }
  const ls: ListState = {
    type: numPr.numId === 1 ? "bullet" : "numbered",
    level: numPr.ilvl ?? 0,
    isInList: true,
  };
  if (numPr.numId !== undefined) {
    ls.numId = numPr.numId;
  }
  return ls;
}

export type BuildSelectionFormattingInput = {
  selectionState: SelectionState;
  fontFamily: string | undefined;
  fontSize: number | undefined;
  /** Resolved text color as a hex string (e.g. `#1a1a1a`), or `undefined`. */
  textColor: string | undefined;
  listState: ListState | undefined;
};

/**
 * Assemble the `SelectionFormatting` object the toolbar consumes.
 *
 * Several fields are `?: T` (no `| undefined`) under
 * `exactOptionalPropertyTypes`, so we only assign them when the source
 * value is defined — assigning `undefined` would be a type error. Pure
 * (no DOM, no PM state mutation).
 */
export function buildSelectionFormatting({
  selectionState,
  fontFamily,
  fontSize,
  textColor,
  listState,
}: BuildSelectionFormattingInput): SelectionFormatting {
  const { textFormatting, paragraphFormatting } = selectionState;
  const formatting: SelectionFormatting = {
    underline: !!textFormatting.underline,
    superscript: textFormatting.vertAlign === "superscript",
    subscript: textFormatting.vertAlign === "subscript",
    bidi: !!paragraphFormatting.bidi,
  };
  if (textFormatting.bold !== undefined) {
    formatting.bold = textFormatting.bold;
  }
  if (textFormatting.italic !== undefined) {
    formatting.italic = textFormatting.italic;
  }
  if (textFormatting.strike !== undefined) {
    formatting.strike = textFormatting.strike;
  }
  if (fontFamily !== undefined) {
    formatting.fontFamily = fontFamily;
  }
  if (fontSize !== undefined) {
    formatting.fontSize = fontSize;
  }
  if (textColor !== undefined) {
    formatting.color = textColor;
  }
  if (textFormatting.highlight !== undefined) {
    formatting.highlight = textFormatting.highlight;
  }
  if (paragraphFormatting.alignment !== undefined) {
    formatting.alignment = paragraphFormatting.alignment;
  }
  if (paragraphFormatting.lineSpacing !== undefined) {
    formatting.lineSpacing = paragraphFormatting.lineSpacing;
  }
  if (listState !== undefined) {
    formatting.listState = listState;
  }
  if (selectionState.styleId) {
    formatting.styleId = selectionState.styleId;
  }
  if (paragraphFormatting.indentLeft !== undefined) {
    formatting.indentLeft = paragraphFormatting.indentLeft;
  }
  return formatting;
}
