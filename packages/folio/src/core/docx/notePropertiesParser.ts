/**
 * Note Properties Parser
 *
 * Parses footnote/endnote properties (w:footnotePr, w:endnotePr) that appear
 * in section properties. Extracted from footnoteParser to break the circular
 * dependency: footnoteParser -> paragraphParser -> sectionParser -> footnoteParser.
 */

import type {
  FootnoteProperties,
  EndnoteProperties,
  FootnotePosition,
  EndnotePosition,
  NoteNumberRestart,
  NumberFormat,
} from "../types/document";
import { narrowEnum, NumberFormatSchema } from "./parserEnums";
import { findChild, getAttribute, parseNumericAttribute } from "./xmlParser";
import type { XmlElement } from "./xmlParser";

// ============================================================================
// HELPER PARSERS
// ============================================================================

function parseNumberFormat(
  numFmtAttr: string | null,
): NumberFormat | undefined {
  return narrowEnum(numFmtAttr, NumberFormatSchema);
}

/**
 * Parse footnote position
 */
function parseFootnotePosition(
  posAttr: string | null,
): FootnotePosition | undefined {
  switch (posAttr) {
    case "pageBottom":
      return "pageBottom";
    case "beneathText":
      return "beneathText";
    case "sectEnd":
      return "sectEnd";
    case "docEnd":
      return "docEnd";
    default:
      return undefined;
  }
}

/**
 * Parse endnote position
 */
function parseEndnotePosition(
  posAttr: string | null,
): EndnotePosition | undefined {
  switch (posAttr) {
    case "sectEnd":
      return "sectEnd";
    case "docEnd":
      return "docEnd";
    default:
      return undefined;
  }
}

/**
 * Parse number restart type
 */
function parseNumberRestart(
  restartAttr: string | null,
): NoteNumberRestart | undefined {
  switch (restartAttr) {
    case "continuous":
      return "continuous";
    case "eachSect":
      return "eachSect";
    case "eachPage":
      return "eachPage";
    default:
      return undefined;
  }
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Parse footnote properties from w:footnotePr element
 * (Can appear in w:sectPr or w:settings)
 */
export function parseFootnoteProperties(
  element: XmlElement | null,
): FootnoteProperties {
  const props: FootnoteProperties = {};

  if (!element) {
    return props;
  }

  const posEl = findChild(element, "w", "pos");
  if (posEl) {
    const position = parseFootnotePosition(getAttribute(posEl, "w", "val"));
    if (position !== undefined) {
      props.position = position;
    }
  }

  const numFmtEl = findChild(element, "w", "numFmt");
  if (numFmtEl) {
    const numFmt = parseNumberFormat(getAttribute(numFmtEl, "w", "val"));
    if (numFmt !== undefined) {
      props.numFmt = numFmt;
    }
  }

  const numStartEl = findChild(element, "w", "numStart");
  if (numStartEl) {
    const numStart = parseNumericAttribute(numStartEl, "w", "val");
    if (numStart != null) {
      props.numStart = numStart;
    }
  }

  const numRestartEl = findChild(element, "w", "numRestart");
  if (numRestartEl) {
    const numRestart = parseNumberRestart(
      getAttribute(numRestartEl, "w", "val"),
    );
    if (numRestart !== undefined) {
      props.numRestart = numRestart;
    }
  }

  return props;
}

/**
 * Parse endnote properties from w:endnotePr element
 * (Can appear in w:sectPr or w:settings)
 */
export function parseEndnoteProperties(
  element: XmlElement | null,
): EndnoteProperties {
  const props: EndnoteProperties = {};

  if (!element) {
    return props;
  }

  const posEl = findChild(element, "w", "pos");
  if (posEl) {
    const position = parseEndnotePosition(getAttribute(posEl, "w", "val"));
    if (position !== undefined) {
      props.position = position;
    }
  }

  const numFmtEl = findChild(element, "w", "numFmt");
  if (numFmtEl) {
    const numFmt = parseNumberFormat(getAttribute(numFmtEl, "w", "val"));
    if (numFmt !== undefined) {
      props.numFmt = numFmt;
    }
  }

  const numStartEl = findChild(element, "w", "numStart");
  if (numStartEl) {
    const numStart = parseNumericAttribute(numStartEl, "w", "val");
    if (numStart != null) {
      props.numStart = numStart;
    }
  }

  const numRestartEl = findChild(element, "w", "numRestart");
  if (numRestartEl) {
    const numRestart = parseNumberRestart(
      getAttribute(numRestartEl, "w", "val"),
    );
    if (numRestart !== undefined) {
      props.numRestart = numRestart;
    }
  }

  return props;
}
