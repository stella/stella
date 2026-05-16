/**
 * Toolbar Utility Functions
 *
 * Pure utility functions for formatting state extraction and action application.
 * Extracted from Toolbar.tsx to reduce file size.
 */

import type {
  TextFormatting,
  ParagraphFormatting,
} from "../core/types/document";
import { pointsToHalfPoints } from "../core/utils/units";
import type { SelectionFormatting, FormattingAction } from "./Toolbar";
import { createDefaultListState } from "./ui/ListButtons";

// ============================================================================
// HIGHLIGHT COLOR MAPPING
// ============================================================================

/**
 * Map hex color to OOXML highlight color name
 * OOXML uses named colors for highlights (yellow, green, cyan, etc.)
 */
const HIGHLIGHT_HEX_TO_NAME: Record<string, string> = {
  FFFF00: "yellow",
  "00FF00": "green",
  "00FFFF": "cyan",
  FF00FF: "magenta",
  "0000FF": "blue",
  FF0000: "red",
  "00008B": "darkBlue",
  "008080": "darkCyan",
  "008000": "darkGreen",
  "800080": "darkMagenta",
  "8B0000": "darkRed",
  "808000": "darkYellow",
  "808080": "darkGray",
  C0C0C0: "lightGray",
  "000000": "black",
  FFFFFF: "white",
};

export function mapHexToHighlightName(hex: string): string | null {
  const normalized = hex.replace(/^#/, "").toUpperCase();
  return HIGHLIGHT_HEX_TO_NAME[normalized] || null;
}

// ============================================================================
// FORMATTING STATE EXTRACTION
// ============================================================================

/**
 * Extract formatting state from TextFormatting and ParagraphFormatting objects
 */
export function getSelectionFormatting(
  formatting?: Partial<TextFormatting>,
  paragraphFormatting?: Partial<ParagraphFormatting>,
): SelectionFormatting {
  const result: SelectionFormatting = {};

  if (formatting) {
    if (formatting.bold !== undefined) {
      result.bold = formatting.bold;
    }
    if (formatting.italic !== undefined) {
      result.italic = formatting.italic;
    }
    result.underline =
      formatting.underline?.style !== "none" &&
      formatting.underline?.style !== undefined;
    if (formatting.strike !== undefined) {
      result.strike = formatting.strike;
    }
    result.superscript = formatting.vertAlign === "superscript";
    result.subscript = formatting.vertAlign === "subscript";
    const resolvedFont =
      formatting.fontFamily?.ascii || formatting.fontFamily?.hAnsi;
    if (resolvedFont !== undefined) {
      result.fontFamily = resolvedFont;
    }
    if (formatting.fontSize !== undefined) {
      result.fontSize = formatting.fontSize;
    }
    if (formatting.color?.rgb) {
      result.color = `#${formatting.color.rgb}`;
    }
    if (formatting.highlight !== undefined && formatting.highlight !== "none") {
      result.highlight = formatting.highlight;
    }
  }

  if (paragraphFormatting) {
    if (paragraphFormatting.alignment !== undefined) {
      result.alignment = paragraphFormatting.alignment;
    }

    if (paragraphFormatting.lineSpacing !== undefined) {
      result.lineSpacing = paragraphFormatting.lineSpacing;
    }

    if (paragraphFormatting.styleId) {
      result.styleId = paragraphFormatting.styleId;
    }

    if (paragraphFormatting.numPr) {
      const { numId, ilvl } = paragraphFormatting.numPr;
      const isBullet = numId === 1;
      const listState: SelectionFormatting["listState"] & object = {
        type: isBullet ? "bullet" : "numbered",
        level: ilvl ?? 0,
        isInList: true,
      };
      if (numId !== undefined) {
        listState.numId = numId;
      }
      result.listState = listState;
    } else {
      result.listState = createDefaultListState();
    }
  }

  return result;
}

// ============================================================================
// FORMATTING ACTION APPLICATION
// ============================================================================

/**
 * Apply a formatting action to existing formatting, returning new formatting
 */
export function applyFormattingAction(
  currentFormatting: TextFormatting,
  action: FormattingAction,
): TextFormatting {
  const newFormatting = { ...currentFormatting };

  if (typeof action === "object") {
    switch (action.type) {
      case "fontFamily":
        newFormatting.fontFamily = {
          ...currentFormatting.fontFamily,
          ascii: action.value,
          hAnsi: action.value,
        };
        return newFormatting;
      case "fontSize":
        newFormatting.fontSize = pointsToHalfPoints(action.value);
        return newFormatting;
      case "textColor": {
        const val = action.value;
        if (typeof val === "string") {
          newFormatting.color = { rgb: val.replace(/^#/, "").toUpperCase() };
        } else if (val.auto) {
          delete newFormatting.color;
        } else {
          newFormatting.color = val;
        }
        return newFormatting;
      }
      case "highlightColor":
        if (action.value === "" || action.value === "none") {
          newFormatting.highlight = "none";
        } else {
          newFormatting.highlight = (mapHexToHighlightName(action.value) ||
            "yellow") as NonNullable<TextFormatting["highlight"]>;
        }
        return newFormatting;
      case "alignment":
      case "applyStyle":
      case "lineSpacing":
        // Paragraph-level actions — not handled by this run-formatting
        // dispatcher; the paragraph handler picks them up elsewhere.
        break;
    }
  }

  switch (action) {
    case "bold":
      newFormatting.bold = !currentFormatting.bold;
      break;
    case "italic":
      newFormatting.italic = !currentFormatting.italic;
      break;
    case "underline":
      if (
        currentFormatting.underline?.style &&
        currentFormatting.underline.style !== "none"
      ) {
        delete newFormatting.underline;
      } else {
        newFormatting.underline = { style: "single" };
      }
      break;
    case "strikethrough":
      newFormatting.strike = !currentFormatting.strike;
      break;
    case "superscript":
      newFormatting.vertAlign =
        currentFormatting.vertAlign === "superscript"
          ? "baseline"
          : "superscript";
      break;
    case "subscript":
      newFormatting.vertAlign =
        currentFormatting.vertAlign === "subscript" ? "baseline" : "subscript";
      break;
    case "clearFormatting":
      return {};
    case "bulletList":
    case "numberedList":
    case "indent":
    case "outdent":
    case "insertPageBreak":
    case "setLtr":
    case "setRtl":
      // Block-level actions handled by the document-level dispatcher,
      // not by this run-formatting function.
      break;
  }

  return newFormatting;
}

/**
 * Check if formatting has any active styles
 */
export function hasActiveFormatting(formatting?: SelectionFormatting): boolean {
  if (!formatting) {
    return false;
  }
  return !!(
    formatting.bold ||
    formatting.italic ||
    formatting.underline ||
    formatting.strike ||
    formatting.superscript ||
    formatting.subscript
  );
}
