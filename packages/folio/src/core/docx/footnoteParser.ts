/**
 * Footnote/Endnote Parser - Parse footnotes.xml and endnotes.xml
 *
 * Footnotes and endnotes are stored in separate XML files within the DOCX package:
 * - word/footnotes.xml - Contains all footnote definitions
 * - word/endnotes.xml - Contains all endnote definitions
 *
 * Each note contains:
 * - An ID that matches references in document.xml (w:footnoteReference, w:endnoteReference)
 * - A type (normal, separator, continuationSeparator, continuationNotice)
 * - Content (paragraphs)
 *
 * The references in the document body are parsed by runParser as NoteReferenceContent.
 *
 * OOXML Reference:
 * - Footnote: w:footnote[@w:id][@w:type]
 * - Endnote: w:endnote[@w:id][@w:type]
 * - Content: w:p (paragraphs)
 */

import type {
  Footnote,
  Endnote,
  Paragraph,
  Table,
  Theme,
  RelationshipMap,
  MediaFile,
} from "../types/document";
import type { NumberingMap } from "./numberingParser";
import { parseParagraph } from "./paragraphParser";
import type { StyleMap } from "./styleParser";
import { parseTable } from "./tableParser";
import {
  parseXml,
  findChildren,
  getChildElements,
  getAttributes,
  getLocalName,
} from "./xmlParser";
import type { XmlElement } from "./xmlParser";

// ============================================================================
// FOOTNOTE MAP INTERFACE
// ============================================================================

/**
 * Footnote map returned by parseFootnotes
 */
export type FootnoteMap = {
  /** All footnotes indexed by ID */
  byId: Map<number, Footnote>;

  /** Array of all footnotes in document order */
  footnotes: Footnote[];

  /** Get footnote by ID */
  getFootnote(id: number): Footnote | undefined;

  /** Check if footnote exists */
  hasFootnote(id: number): boolean;

  /** Get all normal (non-separator) footnotes */
  getNormalFootnotes(): Footnote[];

  /** Get separator footnote if exists */
  getSeparator(): Footnote | undefined;

  /** Get continuation separator if exists */
  getContinuationSeparator(): Footnote | undefined;
};

/**
 * Endnote map returned by parseEndnotes
 */
export type EndnoteMap = {
  /** All endnotes indexed by ID */
  byId: Map<number, Endnote>;

  /** Array of all endnotes in document order */
  endnotes: Endnote[];

  /** Get endnote by ID */
  getEndnote(id: number): Endnote | undefined;

  /** Check if endnote exists */
  hasEndnote(id: number): boolean;

  /** Get all normal (non-separator) endnotes */
  getNormalEndnotes(): Endnote[];

  /** Get separator endnote if exists */
  getSeparator(): Endnote | undefined;

  /** Get continuation separator if exists */
  getContinuationSeparator(): Endnote | undefined;
};

// ============================================================================
// NOTE TYPE PARSING
// ============================================================================

/**
 * Parse note type attribute
 */
function parseNoteType(
  typeAttr: string | null,
): "normal" | "separator" | "continuationSeparator" | "continuationNotice" {
  switch (typeAttr) {
    case "separator":
      return "separator";
    case "continuationSeparator":
      return "continuationSeparator";
    case "continuationNotice":
      return "continuationNotice";
    default:
      return "normal";
  }
}

function getNoteAttribute(
  element: XmlElement,
  localName: "id" | "type",
): string | null {
  for (const [name, value] of Object.entries(getAttributes(element))) {
    if (getLocalName(name) === localName) {
      return value;
    }
  }

  return null;
}

function parseNoteId(element: XmlElement): number {
  const id = getNoteAttribute(element, "id");
  if (id === null) {
    return 0;
  }

  const parsed = Number.parseInt(id, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

// ============================================================================
// FOOTNOTE PARSING
// ============================================================================

function parseNoteBlockContent(
  element: XmlElement,
  styles: StyleMap | null,
  theme: Theme | null,
  numbering: NumberingMap | null,
  rels: RelationshipMap | null,
  media: Map<string, MediaFile> | null,
): (Paragraph | Table)[] {
  const blocks: (Paragraph | Table)[] = [];

  for (const child of getChildElements(element)) {
    const localName = getLocalName(child.name ?? "");
    if (localName === "p") {
      blocks.push(parseParagraph(child, styles, theme, numbering, rels));
    } else if (localName === "tbl") {
      blocks.push(parseTable(child, styles, theme, numbering, rels, media));
    }
  }

  return blocks;
}

/**
 * Parse a single footnote element (w:footnote)
 */
function parseFootnote(
  element: XmlElement,
  styles: StyleMap | null,
  theme: Theme | null,
  numbering: NumberingMap | null,
  rels: RelationshipMap | null,
  media: Map<string, MediaFile> | null,
): Footnote {
  const id = parseNoteId(element);
  const typeAttr = getNoteAttribute(element, "type");
  const noteType = parseNoteType(typeAttr);

  const content = parseNoteBlockContent(
    element,
    styles,
    theme,
    numbering,
    rels,
    media,
  );

  return {
    type: "footnote",
    id,
    noteType,
    content,
  };
}

/**
 * Parse footnotes.xml
 *
 * @param footnotesXml - The raw XML content of word/footnotes.xml
 * @param styles - Parsed style map for applying styles
 * @param theme - Parsed theme for color resolution
 * @param numbering - Parsed numbering definitions for lists
 * @param rels - Relationships for resolving hyperlinks
 * @param media - Media files for images
 * @returns FootnoteMap with all footnotes
 */
export function parseFootnotes(
  footnotesXml: string | null,
  styles: StyleMap | null = null,
  theme: Theme | null = null,
  numbering: NumberingMap | null = null,
  rels: RelationshipMap | null = null,
  media: Map<string, MediaFile> | null = null,
): FootnoteMap {
  const byId = new Map<number, Footnote>();
  const footnotes: Footnote[] = [];

  if (!footnotesXml) {
    return createFootnoteMap(byId, footnotes);
  }

  const doc = parseXml(footnotesXml);
  if (!doc) {
    return createFootnoteMap(byId, footnotes);
  }

  // Find the root footnotes element
  const rootElement = doc.elements?.find(
    (el: XmlElement) =>
      el.type === "element" &&
      (el.name === "w:footnotes" || el.name?.endsWith(":footnotes")),
  ) as XmlElement | undefined;

  if (!rootElement) {
    return createFootnoteMap(byId, footnotes);
  }

  // Parse all footnote elements
  const footnoteElements = findChildren(rootElement, "w", "footnote");

  for (const fnEl of footnoteElements) {
    const footnote = parseFootnote(fnEl, styles, theme, numbering, rels, media);
    byId.set(footnote.id, footnote);
    footnotes.push(footnote);
  }

  return createFootnoteMap(byId, footnotes);
}

/**
 * Create FootnoteMap object with helper methods
 */
function createFootnoteMap(
  byId: Map<number, Footnote>,
  footnotes: Footnote[],
): FootnoteMap {
  return {
    byId,
    footnotes,

    getFootnote(id: number): Footnote | undefined {
      return byId.get(id);
    },

    hasFootnote(id: number): boolean {
      return byId.has(id);
    },

    getNormalFootnotes(): Footnote[] {
      return footnotes.filter((fn) => fn.noteType === "normal");
    },

    getSeparator(): Footnote | undefined {
      return footnotes.find((fn) => fn.noteType === "separator");
    },

    getContinuationSeparator(): Footnote | undefined {
      return footnotes.find((fn) => fn.noteType === "continuationSeparator");
    },
  };
}

// ============================================================================
// ENDNOTE PARSING
// ============================================================================

/**
 * Parse a single endnote element (w:endnote)
 */
function parseEndnote(
  element: XmlElement,
  styles: StyleMap | null,
  theme: Theme | null,
  numbering: NumberingMap | null,
  rels: RelationshipMap | null,
  media: Map<string, MediaFile> | null,
): Endnote {
  const id = parseNoteId(element);
  const typeAttr = getNoteAttribute(element, "type");
  const noteType = parseNoteType(typeAttr);

  const content = parseNoteBlockContent(
    element,
    styles,
    theme,
    numbering,
    rels,
    media,
  );

  return {
    type: "endnote",
    id,
    noteType,
    content,
  };
}

/**
 * Parse endnotes.xml
 *
 * @param endnotesXml - The raw XML content of word/endnotes.xml
 * @param styles - Parsed style map for applying styles
 * @param theme - Parsed theme for color resolution
 * @param numbering - Parsed numbering definitions for lists
 * @param rels - Relationships for resolving hyperlinks
 * @param media - Media files for images
 * @returns EndnoteMap with all endnotes
 */
export function parseEndnotes(
  endnotesXml: string | null,
  styles: StyleMap | null = null,
  theme: Theme | null = null,
  numbering: NumberingMap | null = null,
  rels: RelationshipMap | null = null,
  media: Map<string, MediaFile> | null = null,
): EndnoteMap {
  const byId = new Map<number, Endnote>();
  const endnotes: Endnote[] = [];

  if (!endnotesXml) {
    return createEndnoteMap(byId, endnotes);
  }

  const doc = parseXml(endnotesXml);
  if (!doc) {
    return createEndnoteMap(byId, endnotes);
  }

  // Find the root endnotes element
  const rootElement = doc.elements?.find(
    (el: XmlElement) =>
      el.type === "element" &&
      (el.name === "w:endnotes" || el.name?.endsWith(":endnotes")),
  ) as XmlElement | undefined;

  if (!rootElement) {
    return createEndnoteMap(byId, endnotes);
  }

  // Parse all endnote elements
  const endnoteElements = findChildren(rootElement, "w", "endnote");

  for (const enEl of endnoteElements) {
    const endnote = parseEndnote(enEl, styles, theme, numbering, rels, media);
    byId.set(endnote.id, endnote);
    endnotes.push(endnote);
  }

  return createEndnoteMap(byId, endnotes);
}

/**
 * Create EndnoteMap object with helper methods
 */
function createEndnoteMap(
  byId: Map<number, Endnote>,
  endnotes: Endnote[],
): EndnoteMap {
  return {
    byId,
    endnotes,

    getEndnote(id: number): Endnote | undefined {
      return byId.get(id);
    },

    hasEndnote(id: number): boolean {
      return byId.has(id);
    },

    getNormalEndnotes(): Endnote[] {
      return endnotes.filter((en) => en.noteType === "normal");
    },

    getSeparator(): Endnote | undefined {
      return endnotes.find((en) => en.noteType === "separator");
    },

    getContinuationSeparator(): Endnote | undefined {
      return endnotes.find((en) => en.noteType === "continuationSeparator");
    },
  };
}

// Re-export note properties parsers for backward compatibility
export {
  parseFootnoteProperties,
  parseEndnoteProperties,
} from "./notePropertiesParser";

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get plain text content of a footnote
 */
export function getFootnoteText(footnote: Footnote): string {
  // Import getParagraphText dynamically to avoid circular dependency
  const texts: string[] = [];

  for (const para of footnote.content) {
    if (para.type !== "paragraph") {
      continue;
    }
    const paraTexts: string[] = [];
    for (const content of para.content) {
      if (content.type === "run") {
        for (const runContent of content.content) {
          if (runContent.type === "text") {
            paraTexts.push(runContent.text);
          }
        }
      }
    }
    texts.push(paraTexts.join(""));
  }

  return texts.join("\n");
}

/**
 * Get plain text content of an endnote
 */
export function getEndnoteText(endnote: Endnote): string {
  const texts: string[] = [];

  for (const para of endnote.content) {
    if (para.type !== "paragraph") {
      continue;
    }
    const paraTexts: string[] = [];
    for (const content of para.content) {
      if (content.type === "run") {
        for (const runContent of content.content) {
          if (runContent.type === "text") {
            paraTexts.push(runContent.text);
          }
        }
      }
    }
    texts.push(paraTexts.join(""));
  }

  return texts.join("\n");
}

/**
 * Check if a footnote is a separator (not regular content)
 */
export function isSeparatorFootnote(footnote: Footnote): boolean {
  return (
    footnote.noteType === "separator" ||
    footnote.noteType === "continuationSeparator" ||
    footnote.noteType === "continuationNotice"
  );
}

/**
 * Check if an endnote is a separator (not regular content)
 */
export function isSeparatorEndnote(endnote: Endnote): boolean {
  return (
    endnote.noteType === "separator" ||
    endnote.noteType === "continuationSeparator" ||
    endnote.noteType === "continuationNotice"
  );
}

/**
 * Get footnote number for display (excluding separators)
 * @param footnote - The footnote to get the number for
 * @param footnoteMap - The footnote map
 * @param startNumber - Starting number (default 1)
 * @returns The display number, or null for separator footnotes
 */
export function getFootnoteDisplayNumber(
  footnote: Footnote,
  footnoteMap: FootnoteMap,
  startNumber: number = 1,
): number | null {
  if (isSeparatorFootnote(footnote)) {
    return null;
  }

  const normalFootnotes = footnoteMap.getNormalFootnotes();
  const index = normalFootnotes.findIndex((fn) => fn.id === footnote.id);

  if (index === -1) {
    return null;
  }

  return startNumber + index;
}

/**
 * Get endnote number for display (excluding separators)
 * @param endnote - The endnote to get the number for
 * @param endnoteMap - The endnote map
 * @param startNumber - Starting number (default 1)
 * @returns The display number, or null for separator endnotes
 */
export function getEndnoteDisplayNumber(
  endnote: Endnote,
  endnoteMap: EndnoteMap,
  startNumber: number = 1,
): number | null {
  if (isSeparatorEndnote(endnote)) {
    return null;
  }

  const normalEndnotes = endnoteMap.getNormalEndnotes();
  const index = normalEndnotes.findIndex((en) => en.id === endnote.id);

  if (index === -1) {
    return null;
  }

  return startNumber + index;
}

/**
 * Create an empty footnote map
 */
export function createEmptyFootnoteMap(): FootnoteMap {
  return createFootnoteMap(new Map(), []);
}

/**
 * Create an empty endnote map
 */
export function createEmptyEndnoteMap(): EndnoteMap {
  return createEndnoteMap(new Map(), []);
}

/**
 * Merge multiple footnote maps (e.g., from different documents)
 */
export function mergeFootnoteMaps(...maps: FootnoteMap[]): FootnoteMap {
  const byId = new Map<number, Footnote>();
  const footnotes: Footnote[] = [];

  for (const map of maps) {
    for (const fn of map.footnotes) {
      if (!byId.has(fn.id)) {
        byId.set(fn.id, fn);
        footnotes.push(fn);
      }
    }
  }

  return createFootnoteMap(byId, footnotes);
}

/**
 * Merge multiple endnote maps (e.g., from different documents)
 */
export function mergeEndnoteMaps(...maps: EndnoteMap[]): EndnoteMap {
  const byId = new Map<number, Endnote>();
  const endnotes: Endnote[] = [];

  for (const map of maps) {
    for (const en of map.endnotes) {
      if (!byId.has(en.id)) {
        byId.set(en.id, en);
        endnotes.push(en);
      }
    }
  }

  return createEndnoteMap(byId, endnotes);
}
