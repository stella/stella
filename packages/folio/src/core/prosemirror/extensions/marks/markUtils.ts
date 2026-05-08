/**
 * Shared mark utility functions
 *
 * setMark, removeMark, isMarkActive, getMarkAttr, marksToTextFormatting, textFormattingToMarks, clearFormatting
 */

import type { MarkType, Mark, Schema } from "prosemirror-model";
import type { Command, EditorState, Transaction } from "prosemirror-state";

import type {
  TextFormatting,
  UnderlineStyle,
  ThemeColorSlot,
} from "../../../types/document";
import {
  applyRunFormattingOverrideMark,
  buildRunFormattingOverrideAttrs,
} from "./RunFormattingOverrideExtension";

type MarkAttrs = Record<string, unknown>;

// ============================================================================
// PARAGRAPH DEFAULT FORMATTING HELPERS
// ============================================================================

function marksToTextFormatting(marks: readonly Mark[]): TextFormatting {
  const formatting: TextFormatting = {};

  for (const mark of marks) {
    switch (mark.type.name) {
      case "bold":
        formatting.bold = true;
        break;
      case "italic":
        formatting.italic = true;
        break;
      case "underline": {
        // SAFETY: underline mark always has style attr per schema; value is a valid UnderlineStyle
        const underlineStyle = (
          typeof mark.attrs["style"] === "string"
            ? mark.attrs["style"]
            : "single"
        ) as UnderlineStyle;
        formatting.underline = { style: underlineStyle };
        break;
      }
      case "strike":
        formatting.strike = true;
        break;
      case "textColor": {
        // SAFETY: textColor mark attrs always match ColorValue shape — extracted individually;
        // themeColor is always a valid ThemeColorSlot string per schema
        const colorRgb =
          mark.attrs["rgb"] !== null && mark.attrs["rgb"] !== undefined
            ? String(mark.attrs["rgb"])
            : undefined;
        const colorTheme =
          mark.attrs["themeColor"] !== null &&
          mark.attrs["themeColor"] !== undefined
            ? (String(mark.attrs["themeColor"]) as ThemeColorSlot)
            : undefined;
        const colorTint =
          mark.attrs["themeTint"] !== null &&
          mark.attrs["themeTint"] !== undefined
            ? String(mark.attrs["themeTint"])
            : undefined;
        const colorShade =
          mark.attrs["themeShade"] !== null &&
          mark.attrs["themeShade"] !== undefined
            ? String(mark.attrs["themeShade"])
            : undefined;
        formatting.color = {
          ...(colorRgb !== undefined ? { rgb: colorRgb } : {}),
          ...(colorTheme !== undefined ? { themeColor: colorTheme } : {}),
          ...(colorTint !== undefined ? { themeTint: colorTint } : {}),
          ...(colorShade !== undefined ? { themeShade: colorShade } : {}),
        };
        break;
      }
      case "highlight":
        // SAFETY: highlight mark always has color attr per schema; value is a valid highlight union member
        formatting.highlight = String(mark.attrs["color"]) as NonNullable<
          TextFormatting["highlight"]
        >;
        break;
      case "fontSize":
        // SAFETY: fontSize mark always has size attr per schema
        formatting.fontSize = Number(mark.attrs["size"]);
        break;
      case "fontFamily": {
        // SAFETY: fontFamily mark always has ascii/hAnsi attrs per schema
        const ascii =
          mark.attrs["ascii"] !== null && mark.attrs["ascii"] !== undefined
            ? String(mark.attrs["ascii"])
            : undefined;
        const hAnsi =
          mark.attrs["hAnsi"] !== null && mark.attrs["hAnsi"] !== undefined
            ? String(mark.attrs["hAnsi"])
            : undefined;
        formatting.fontFamily = {
          ...(ascii !== undefined ? { ascii } : {}),
          ...(hAnsi !== undefined ? { hAnsi } : {}),
        };
        break;
      }
      case "superscript":
        formatting.vertAlign = "superscript";
        break;
      case "subscript":
        formatting.vertAlign = "subscript";
        break;
      case "runFormattingOverride":
        applyRunFormattingOverrideMark(formatting, mark);
        break;
      default:
        break;
    }
  }

  return formatting;
}

function saveStoredMarksToParagraph(
  state: EditorState,
  tr: Transaction,
  marks: readonly Mark[],
): Transaction {
  const { $from } = state.selection;
  const paragraph = $from.parent;

  if (paragraph.type.name !== "paragraph") {
    return tr;
  }
  if (paragraph.textContent.length > 0) {
    return tr;
  }

  if (marks.length === 0) {
    return tr.setNodeMarkup($from.before(), undefined, {
      ...paragraph.attrs,
      defaultTextFormatting: null,
    });
  }

  const defaultTextFormatting = marksToTextFormatting(marks);

  return tr.setNodeMarkup($from.before(), undefined, {
    ...paragraph.attrs,
    defaultTextFormatting,
  });
}

// ============================================================================
// CORE MARK COMMANDS
// ============================================================================

function dispatchStoredMarks(
  state: EditorState,
  dispatch: (tr: Transaction) => void,
  marks: readonly Mark[],
): void {
  let tr = state.tr;
  tr = saveStoredMarksToParagraph(state, tr, marks);
  tr.setStoredMarks(marks);
  dispatch(tr);
}

export function setMark(markType: MarkType, attrs: MarkAttrs): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    const mark = markType.create(attrs);

    if (empty) {
      if (dispatch) {
        const current = state.storedMarks ?? state.selection.$from.marks();
        const marks = markType.isInSet(current)
          ? current.filter((m) => m.type !== markType)
          : current;

        dispatchStoredMarks(state, dispatch, [...marks, mark]);
      }
      return true;
    }

    if (dispatch) {
      dispatch(state.tr.addMark(from, to, mark).scrollIntoView());
    }

    return true;
  };
}

export function removeMark(markType: MarkType): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;

    if (empty) {
      if (dispatch) {
        const marks = (
          state.storedMarks ?? state.selection.$from.marks()
        ).filter((m) => m.type !== markType);
        dispatchStoredMarks(state, dispatch, marks);
      }
      return true;
    }

    if (dispatch) {
      dispatch(state.tr.removeMark(from, to, markType).scrollIntoView());
    }

    return true;
  };
}

/**
 * Check if a mark is active in the current selection
 */
export function isMarkActive(
  state: EditorState,
  markType: MarkType,
  attrs?: Record<string, unknown>,
): boolean {
  const { from, to, empty } = state.selection;

  if (empty) {
    const marks = state.storedMarks ?? state.selection.$from.marks();
    return marks.some((mark) => {
      if (mark.type !== markType) {
        return false;
      }
      if (!attrs) {
        return true;
      }
      return Object.entries(attrs).every(
        ([key, value]) => mark.attrs[key] === value,
      );
    });
  }

  let hasMark = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isText) {
      const mark = markType.isInSet(node.marks);
      if (mark) {
        if (!attrs) {
          hasMark = true;
          return false;
        }
        const attrsMatch = Object.entries(attrs).every(
          ([key, value]) => mark.attrs[key] === value,
        );
        if (attrsMatch) {
          hasMark = true;
          return false;
        }
      }
    }
    return true;
  });

  return hasMark;
}

/**
 * Get the current value of a mark attribute
 */
export function getMarkAttr(
  state: EditorState,
  markType: MarkType,
  attr: string,
): unknown {
  const { empty, $from, from, to } = state.selection;

  if (empty) {
    const marks = state.storedMarks ?? $from.marks();
    for (const mark of marks) {
      if (mark.type === markType) {
        return mark.attrs[attr];
      }
    }
    return null;
  }

  let value: unknown = null;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isText && value === null) {
      const mark = markType.isInSet(node.marks);
      if (mark) {
        value = mark.attrs[attr];
        return false;
      }
    }
    return true;
  });

  return value;
}

/**
 * Convert TextFormatting to marks array (used to restore formatting on empty paragraphs)
 */
export function textFormattingToMarks(
  formatting: TextFormatting,
  schema: Schema,
): Mark[] {
  const marks: Mark[] = [];
  const overrideAttrs = buildRunFormattingOverrideAttrs(formatting);

  if (overrideAttrs && schema.marks["runFormattingOverride"]) {
    marks.push(schema.marks["runFormattingOverride"].create(overrideAttrs));
  }

  if (formatting.bold && schema.marks["bold"]) {
    marks.push(schema.marks["bold"].create());
  }
  if (formatting.italic && schema.marks["italic"]) {
    marks.push(schema.marks["italic"].create());
  }
  if (formatting.underline && schema.marks["underline"]) {
    marks.push(
      schema.marks["underline"].create({
        style: formatting.underline.style || "single",
        color: formatting.underline.color,
      }),
    );
  }
  if (formatting.strike && schema.marks["strike"]) {
    marks.push(schema.marks["strike"].create());
  }
  if (formatting.doubleStrike && schema.marks["strike"]) {
    marks.push(schema.marks["strike"].create({ double: true }));
  }
  if (formatting.color && schema.marks["textColor"]) {
    marks.push(
      schema.marks["textColor"].create({
        rgb: formatting.color.rgb,
        themeColor: formatting.color.themeColor,
        themeTint: formatting.color.themeTint,
        themeShade: formatting.color.themeShade,
      }),
    );
  }
  if (formatting.highlight && schema.marks["highlight"]) {
    marks.push(
      schema.marks["highlight"].create({ color: formatting.highlight }),
    );
  }
  if (formatting.fontSize !== undefined && schema.marks["fontSize"]) {
    marks.push(schema.marks["fontSize"].create({ size: formatting.fontSize }));
  }
  if (formatting.fontFamily && schema.marks["fontFamily"]) {
    marks.push(
      schema.marks["fontFamily"].create({
        ascii: formatting.fontFamily.ascii,
        hAnsi: formatting.fontFamily.hAnsi,
        asciiTheme: formatting.fontFamily.asciiTheme,
      }),
    );
  }
  if (formatting.vertAlign === "superscript" && schema.marks["superscript"]) {
    marks.push(schema.marks["superscript"].create());
  }
  if (formatting.vertAlign === "subscript" && schema.marks["subscript"]) {
    marks.push(schema.marks["subscript"].create());
  }

  return marks;
}

/**
 * Clear all text formatting (remove all marks)
 */
export const clearFormatting: Command = (state, dispatch) => {
  const { from, to, empty } = state.selection;

  if (empty) {
    if (dispatch) {
      dispatch(state.tr.setStoredMarks([]));
    }
    return true;
  }

  if (dispatch) {
    let tr = state.tr;

    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.isText && node.marks.length > 0) {
        const start = Math.max(from, pos);
        const end = Math.min(to, pos + node.nodeSize);
        for (const mark of node.marks) {
          tr = tr.removeMark(start, end, mark.type);
        }
      }
    });

    dispatch(tr.scrollIntoView());
  }

  return true;
};

/**
 * Create a command that sets a mark on the selection
 */
export function createSetMarkCommand(
  markType: MarkType,
  attrs?: Record<string, unknown>,
): Command {
  return setMark(markType, attrs ?? {});
}

/**
 * Create a command that removes a mark from the selection
 */
export function createRemoveMarkCommand(markType: MarkType): Command {
  return removeMark(markType);
}
