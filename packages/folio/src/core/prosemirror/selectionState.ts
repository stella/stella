/**
 * Selection State Utilities
 *
 * Extracts selection state from ProseMirror for toolbar integration.
 */

import type { Mark } from "prosemirror-model";
import type { EditorState } from "prosemirror-state";

import type { TextFormatting, ParagraphFormatting } from "../types/document";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Selection state for toolbar integration
 */
export type SelectionState = {
  /** Whether there's an active selection (not just cursor) */
  hasSelection: boolean;
  /** Whether selection spans multiple paragraphs */
  isMultiParagraph: boolean;
  /** Current text formatting at selection/cursor */
  textFormatting: TextFormatting;
  /** Current paragraph formatting */
  paragraphFormatting: ParagraphFormatting;
  /** Current paragraph style ID (e.g., 'Heading1', 'Normal') */
  styleId: string | null;
  /** Start paragraph index */
  startParagraphIndex: number;
  /** End paragraph index */
  endParagraphIndex: number;
};

// ============================================================================
// FUNCTIONS
// ============================================================================

/**
 * Extract selection state from editor state.
 * Used by PagedEditor integration in DocxEditor for toolbar state.
 */
export function extractSelectionState(
  state: EditorState,
): SelectionState | null {
  const { selection, doc } = state;
  const { from, to, empty } = selection;

  // Find containing paragraphs
  const $from = doc.resolve(from);

  // Get paragraph indices
  let startParagraphIndex = 0;
  let endParagraphIndex = 0;

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  doc.forEach((_node, offset, index) => {
    if (offset <= from) {
      startParagraphIndex = index;
    }
    if (offset <= to) {
      endParagraphIndex = index;
    }
  });

  // Get current text formatting from marks at selection
  let textFormatting: TextFormatting = {};

  // Check paragraph for default text formatting (for empty paragraphs)
  const paragraph = $from.parent;
  const isEmptyParagraph =
    paragraph.type.name === "paragraph" && paragraph.textContent.length === 0;
  const paragraphDefaultFormatting = paragraph.attrs[
    "defaultTextFormatting"
  ] as TextFormatting | undefined;

  // For empty selection (cursor), use stored marks or marks at cursor position.
  // For non-empty selections, $from.marks() is left-biased — when the selection
  // starts at a text-node boundary it returns marks of the node before $from,
  // not of the selected content. That makes the toolbar misreport bold/italic/
  // etc. on selections that start at the first character of a marked run.
  // Match toggleMark's "any inline child in range has the mark" semantics so
  // the toolbar's active state agrees with what a toggle click will toggle.
  const marks = empty
    ? state.storedMarks || selection.$from.marks()
    : collectMarksInRange(doc, from, to);

  // If in empty paragraph with no marks but has defaultTextFormatting, use that
  if (isEmptyParagraph && marks.length === 0 && paragraphDefaultFormatting) {
    textFormatting = { ...paragraphDefaultFormatting };
  }

  // Override with actual marks if present
  for (const mark of marks) {
    switch (mark.type.name) {
      case "bold":
        textFormatting.bold = true;
        break;
      case "italic":
        textFormatting.italic = true;
        break;
      case "underline":
        textFormatting.underline = {
          style: mark.attrs["style"] || "single",
          color: mark.attrs["color"],
        };
        break;
      case "strike":
        if (mark.attrs["double"]) {
          textFormatting.doubleStrike = true;
        } else {
          textFormatting.strike = true;
        }
        break;
      case "textColor":
        textFormatting.color = {
          rgb: mark.attrs["rgb"],
          themeColor: mark.attrs["themeColor"],
        };
        break;
      case "highlight":
        textFormatting.highlight = mark.attrs["color"];
        break;
      case "fontSize":
        textFormatting.fontSize = mark.attrs["size"];
        break;
      case "fontFamily":
        textFormatting.fontFamily = {
          ascii: mark.attrs["ascii"],
          hAnsi: mark.attrs["hAnsi"],
        };
        break;
      case "superscript":
        textFormatting.vertAlign = "superscript";
        break;
      case "subscript":
        textFormatting.vertAlign = "subscript";
        break;
      default:
        break;
    }
  }

  // Get paragraph formatting and styleId from current paragraph
  const paragraphFormatting: ParagraphFormatting = {};
  let styleId: string | null = null;

  if (paragraph.type.name === "paragraph") {
    if (paragraph.attrs["alignment"]) {
      paragraphFormatting.alignment = paragraph.attrs["alignment"];
    }
    if (paragraph.attrs["lineSpacing"]) {
      paragraphFormatting.lineSpacing = paragraph.attrs["lineSpacing"];
      paragraphFormatting.lineSpacingRule = paragraph.attrs["lineSpacingRule"];
    }
    if (paragraph.attrs["numPr"]) {
      paragraphFormatting.numPr = paragraph.attrs["numPr"];
    }
    if (paragraph.attrs["indentLeft"]) {
      paragraphFormatting.indentLeft = paragraph.attrs["indentLeft"];
    }
    if (paragraph.attrs["indentRight"]) {
      paragraphFormatting.indentRight = paragraph.attrs["indentRight"];
    }
    if (paragraph.attrs["indentFirstLine"]) {
      paragraphFormatting.indentFirstLine = paragraph.attrs["indentFirstLine"];
    }
    if (paragraph.attrs["hangingIndent"]) {
      paragraphFormatting.hangingIndent = paragraph.attrs["hangingIndent"];
    }
    if (paragraph.attrs["tabs"]) {
      paragraphFormatting.tabs = paragraph.attrs["tabs"];
    }
    if (paragraph.attrs["bidi"]) {
      paragraphFormatting.bidi = true;
    }
    if (paragraph.attrs["styleId"]) {
      styleId = paragraph.attrs["styleId"];
    }
  }

  return {
    hasSelection: !empty,
    isMultiParagraph: startParagraphIndex !== endParagraphIndex,
    textFormatting,
    paragraphFormatting,
    styleId,
    startParagraphIndex,
    endParagraphIndex,
  };
}

/**
 * Collect the first occurrence of each mark type found on any text node within
 * the range. Mirrors the "any inline child has this mark" semantics that
 * prosemirror-commands' toggleMark uses to decide add-vs-remove, so the
 * toolbar's active state stays consistent with what a toggle click will do.
 */
function collectMarksInRange(
  doc: EditorState["doc"],
  from: number,
  to: number,
): Mark[] {
  const seen = new Map<string, Mark>();
  doc.nodesBetween(from, to, (node) => {
    if (!node.isText) {
      return;
    }
    for (const mark of node.marks) {
      const name = mark.type.name;
      if (!seen.has(name)) {
        seen.set(name, mark);
      }
    }
  });
  return Array.from(seen.values());
}
