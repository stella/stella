/**
 * Document Body Parser - Parse document.xml body content
 *
 * Parses the main document body (w:body) containing paragraphs, tables,
 * and section properties. Also detects template variables {{...}}.
 *
 * OOXML Reference:
 * - Root: w:document
 * - Body: w:body
 * - Content: w:p (paragraphs), w:tbl (tables), w:sdt (structured document tags)
 * - Final section properties: w:body/w:sectPr
 */

import type {
  DocumentBody,
  BlockContent,
  Section,
  Paragraph,
  Table,
  Run,
  SectionProperties,
  Shape,
  ShapeContent,
  Theme,
  RelationshipMap,
  MediaFile,
} from "../types/document";
import type { NumberingMap } from "./numberingParser";
import { parseParagraph, getParagraphText } from "./paragraphParser";
import {
  parseSectionProperties,
  getDefaultSectionProperties,
} from "./sectionParser";
import type { StyleMap } from "./styleParser";
import { parseTable } from "./tableParser";
import {
  isTextBoxDrawing,
  parseTextBox,
  getTextBoxContentElement,
  parseTextBoxContent,
} from "./textBoxParser";
import {
  parseXml,
  findChild,
  findDeep,
  getChildElements,
  getLocalName,
} from "./xmlParser";
import type { XmlElement } from "./xmlParser";

// ============================================================================
// LIST MARKER COMPUTATION
// ============================================================================

/**
 * Convert Symbol font bullet characters to Unicode equivalents
 *
 * DOCX often uses characters from Symbol, Wingdings, or Webdings fonts
 * that don't render correctly without the font. This maps them to
 * standard Unicode bullets that work with any font.
 */
function convertBulletToUnicode(bulletChar: string): string {
  // If empty or whitespace, use standard bullet
  if (!bulletChar || bulletChar.trim() === "") {
    return "•";
  }

  // Get the character code
  const charCode = bulletChar.codePointAt(0);
  if (charCode === undefined) {
    return "•";
  }

  // Map common Symbol/Wingdings characters to Unicode
  // Symbol font mappings (often used for bullets)
  const symbolMap: Record<number, string> = {
    // Symbol font
    0x00_b7: "•", // Middle dot → bullet
    0x00_6f: "○", // lowercase o → white circle (used in Symbol font)
    0x00_a7: "■", // Section sign → black square (Symbol)
    0x00_fc: "✓", // Checkmark in Symbol/Wingdings

    // Wingdings mappings (character codes when Wingdings not available)
    0x00_6e: "■", // Wingdings n → black square
    0x00_71: "○", // Wingdings q → white circle
    0x00_75: "◆", // Wingdings u → black diamond
    0x00_76: "❖", // Wingdings v → diamond
    0x00_a8: "✓", // Wingdings checkmark
    0x00_fb: "✓", // Checkmark
    0x00_fe: "✓", // Checkmark variant

    // Common control characters that might appear
    0xf0_b7: "•", // Private use area bullet
    0xf0_6e: "■", // Private use area square
    0xf0_6f: "○", // Private use area circle
    0xf0_a7: "■", // Private use area
    0xf0_fc: "✓", // Private use area checkmark

    // Other common bullet-like characters
    0x20_22: "•", // Already a bullet
    0x25_cf: "●", // Black circle
    0x25_cb: "○", // White circle
    0x25_a0: "■", // Black square
    0x25_a1: "□", // White square
    0x25_c6: "◆", // Black diamond
    0x25_c7: "◇", // White diamond
    0x20_13: "–", // En dash
    0x20_14: "—", // Em dash
    0x00_3e: ">", // Greater than (used as arrow)
    0x00_2d: "-", // Hyphen
  };

  // Check if we have a mapping for this character
  if (symbolMap[charCode]) {
    return symbolMap[charCode];
  }

  // If it's in the private use area (often Symbol/Wingdings), use bullet
  if (charCode >= 0xe0_00 && charCode <= 0xf8_ff) {
    return "•";
  }

  // If it's a control character or non-printable, use bullet
  if (charCode < 32 || (charCode >= 127 && charCode < 160)) {
    return "•";
  }

  // Otherwise, use the character as-is (might be a valid Unicode bullet)
  return bulletChar;
}

/**
 * Compute the actual list marker for a paragraph
 *
 * Replaces %1, %2, etc. in lvlText with actual counter values.
 * Tracks and increments counters as list items are encountered.
 *
 * @param paragraph - The paragraph to compute marker for
 * @param numbering - Numbering definitions
 * @param listCounters - Map tracking counters per numId
 * @param abstractCounters - Map tracking latest counters per abstractNumId
 */
function computeListMarker(
  paragraph: Paragraph,
  numbering: NumberingMap | null,
  listCounters: Map<number, number[]>,
  abstractCounters: Map<number, number[]>,
): void {
  const listRendering = paragraph.listRendering;
  if (!listRendering || !numbering) {
    return;
  }

  const { numId, level } = listRendering;
  if (numId === 0) {
    return;
  }

  // Initialize counters for this numId if not exists
  if (!listCounters.has(numId)) {
    listCounters.set(numId, Array.from<number>({ length: 9 }).fill(0)); // Up to 9 levels
  }

  const counters = listCounters.get(numId);
  if (!counters) {
    return;
  }

  const abstractNumId = numbering.getAbstractNumId(numId);
  if (abstractNumId !== null && level > 0) {
    const latestAbstractCounters = abstractCounters.get(abstractNumId);
    const missingParentCounters = counters
      .slice(0, level)
      .every((value) => value === 0);
    if (latestAbstractCounters && missingParentCounters) {
      for (let i = 0; i < level; i += 1) {
        counters[i] = latestAbstractCounters[i] ?? 0;
      }
    }
  }

  // Increment counter at current level
  counters[level] = (counters[level] || 0) + 1;

  // Reset all deeper level counters when we go to a shallower level
  for (let i = level + 1; i < counters.length; i++) {
    counters[i] = 0;
  }

  if (abstractNumId !== null) {
    abstractCounters.set(abstractNumId, [...counters]);
  }

  // Get the lvlText pattern (e.g., "%1.%2.%3.")
  const pattern = listRendering.marker;

  // For bullet lists, convert Symbol font characters to proper Unicode
  if (listRendering.isBullet) {
    // DOCX often uses Symbol font characters that don't render correctly
    // Map common Symbol font codes to Unicode equivalents
    const bulletChar = pattern || "";
    listRendering.marker = convertBulletToUnicode(bulletChar);
    return;
  }

  // Compute the actual marker by replacing %1, %2, etc.
  let computedMarker = pattern;
  const currentLevelInfo = numbering.getLevel(numId, level);
  const useLegalNumbering =
    currentLevelInfo?.isLgl === true || listRendering.isLegal === true;

  // Replace %1, %2, etc. with actual counter values
  // Format each level according to its numFmt
  for (let lvl = 0; lvl <= level; lvl++) {
    const placeholder = `%${lvl + 1}`;
    if (computedMarker.includes(placeholder)) {
      const value = counters[lvl] ?? 0;
      const levelInfo = numbering.getLevel(numId, lvl);
      const formatted = formatNumber(
        value,
        useLegalNumbering ? "decimal" : levelInfo?.numFmt || "decimal",
      );
      computedMarker = computedMarker.replace(placeholder, formatted);
    }
  }

  // Update the marker with the computed value
  listRendering.marker = computedMarker;
}

/**
 * Format a number according to OOXML number format
 */
function formatNumber(value: number, numFmt: string): string {
  switch (numFmt) {
    case "decimal":
    case "decimalZero":
      return String(value);
    case "lowerLetter":
      return String.fromCodePoint(96 + ((value - 1) % 26) + 1); // a, b, c...
    case "upperLetter":
      return String.fromCodePoint(64 + ((value - 1) % 26) + 1); // A, B, C...
    case "lowerRoman":
      return toRoman(value).toLowerCase();
    case "upperRoman":
      return toRoman(value);
    case "bullet":
      return "•";
    default:
      return String(value);
  }
}

/**
 * Convert number to Roman numerals
 */
function toRoman(numParam: number): string {
  let num = numParam;
  const romanNumerals: [number, string][] = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];

  let result = "";
  for (const [value, symbol] of romanNumerals) {
    while (num >= value) {
      result += symbol;
      num -= value;
    }
  }
  return result;
}

// ============================================================================
// TEMPLATE VARIABLE DETECTION
// ============================================================================

/**
 * Regular expression to match template variables {{...}}
 */
const TEMPLATE_VARIABLE_REGEX = /\{([a-zA-Z_][a-zA-Z0-9_\-.]*)\}/gu;

/**
 * Extract template variables from text
 *
 * @param text - Text to search for variables
 * @returns Array of unique variable names (without braces)
 */
export function extractTemplateVariables(text: string): string[] {
  const variables: string[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  TEMPLATE_VARIABLE_REGEX.lastIndex = 0;

  while ((match = TEMPLATE_VARIABLE_REGEX.exec(text)) !== null) {
    // SAFETY: capture group [1] always present when regex matches
    const varName = match[1]!.trim();
    if (varName && !variables.includes(varName)) {
      variables.push(varName);
    }
  }

  return variables;
}

/**
 * Extract all template variables from document content
 *
 * @param content - Array of paragraphs and tables
 * @returns Array of unique variable names
 */
export function extractAllTemplateVariables(content: BlockContent[]): string[] {
  const variables: string[] = [];

  for (const block of content) {
    if (block.type === "paragraph") {
      const text = getParagraphText(block);
      const vars = extractTemplateVariables(text);
      for (const v of vars) {
        if (!variables.includes(v)) {
          variables.push(v);
        }
      }
    } else if (block.type === "table") {
      // Recursively check table cells
      const tableVars = extractTableVariables(block);
      for (const v of tableVars) {
        if (!variables.includes(v)) {
          variables.push(v);
        }
      }
    }
  }

  return variables;
}

/**
 * Extract template variables from a table
 */
function extractTableVariables(table: Table): string[] {
  const variables: string[] = [];

  for (const row of table.rows) {
    for (const cell of row.cells) {
      for (const cellContent of cell.content) {
        if (cellContent.type === "paragraph") {
          const text = getParagraphText(cellContent);
          const vars = extractTemplateVariables(text);
          for (const v of vars) {
            if (!variables.includes(v)) {
              variables.push(v);
            }
          }
        } else {
          // Nested table
          const nestedVars = extractTableVariables(cellContent);
          for (const v of nestedVars) {
            if (!variables.includes(v)) {
              variables.push(v);
            }
          }
        }
      }
    }
  }

  return variables;
}

// ============================================================================
// TEXT BOX ENRICHMENT
// ============================================================================

/**
 * Enrich a parsed paragraph with text box content from its raw XML.
 *
 * During initial parsing, w:drawing elements containing text boxes (wps:wsp with wps:txbx)
 * are skipped because parseImage returns null for non-image drawings. This function does
 * a second pass over the raw XML to find text box drawings, parse them with their content,
 * and inject ShapeContent into the paragraph's runs.
 */
function enrichParagraphTextBoxes(
  paragraph: Paragraph,
  paraXml: XmlElement,
  styles: StyleMap | null,
  theme: Theme | null,
  numbering: NumberingMap | null,
  rels: RelationshipMap | null,
  media: Map<string, MediaFile> | null,
): void {
  // Early exit: skip paragraphs with no runs (most paragraphs have no text boxes)
  if (paragraph.content.length === 0) {
    return;
  }

  const xmlChildren = getChildElements(paraXml);

  // Walk XML <w:r> children and parsed paragraph runs with two pointers. Empty
  // runs are dropped by consolidateParagraphContent (e.g., when the only child
  // is a text-box drawing that parseDrawingContent skipped), so a strict
  // index-based mapping loses textboxes. The two-pointer walk advances through
  // parsed Run entries, falling back to a fresh Run when the parsed counterpart
  // was dropped so the textbox shape still survives the round-trip.
  let parsedIndex = 0;
  let lastConsumedRun: Run | undefined;

  for (const xmlChild of xmlChildren) {
    if (getLocalName(xmlChild.name ?? "") !== "r") {
      if (
        parsedIndex < paragraph.content.length &&
        paragraph.content[parsedIndex]?.type !== "run"
      ) {
        parsedIndex++;
      }
      continue;
    }

    const { textBoxDrawings, hasNonTextBoxContent } =
      scanRunForTextBoxDrawings(xmlChild);

    const parsedContent = paragraph.content[parsedIndex];
    const parsedRun: Run | undefined =
      parsedContent?.type === "run" ? parsedContent : undefined;

    // If this XML run contained non-textbox content but the parsed pointer is
    // already at a boundary, the run was consolidated into the previous parsed
    // run. Keep the textbox with that merged content instead of crossing the
    // boundary to the next run.
    const targetRun =
      parsedRun ?? (hasNonTextBoxContent ? lastConsumedRun : undefined);

    for (const runEl of textBoxDrawings) {
      const textBox = parseTextBox(runEl);
      if (!textBox) {
        continue;
      }

      // Navigate to wps:wsp to get the txbxContent element
      const wsp = findDeep(runEl, "wps", "wsp");
      if (wsp) {
        const txbxContentEl = getTextBoxContentElement(wsp);
        if (txbxContentEl) {
          textBox.content = parseTextBoxContent(
            txbxContentEl,
            parseParagraph,
            null, // table parser not needed for most text boxes
            styles,
            theme,
            numbering,
            rels ?? undefined,
            media ?? undefined,
          );
        }
      }

      // Convert to Shape with textBody and inject as ShapeContent. Use
      // shapeType "textBox" so the serializer emits the wps:txbx content
      // wrapper on round-trip; otherwise the inner paragraphs are dropped
      // and the shape re-parses as a plain drawing.
      const shape: Shape = {
        type: "shape",
        shapeType: "textBox",
        size: textBox.size,
        ...(textBox.position !== undefined
          ? { position: textBox.position }
          : {}),
        ...(textBox.wrap !== undefined ? { wrap: textBox.wrap } : {}),
        ...(textBox.fill !== undefined ? { fill: textBox.fill } : {}),
        ...(textBox.outline !== undefined ? { outline: textBox.outline } : {}),
        textBody: {
          content: textBox.content,
          ...(textBox.margins !== undefined
            ? { margins: textBox.margins }
            : {}),
        },
      };
      if (textBox.id) {
        shape.id = textBox.id;
      }

      const shapeContent: ShapeContent = { type: "shape", shape };

      // If the parsed run for this XML <w:r> survived consolidation, append
      // the shape to it so the textbox lands next to its sibling content.
      // Otherwise the XML run was dropped (only contained the textbox
      // drawing); insert a standalone Run carrying just the shape at the
      // current position so the textbox is still serialized back out.
      if (targetRun && hasNonTextBoxContent) {
        targetRun.content.push(shapeContent);
      } else {
        const newRun: Run = { type: "run", content: [shapeContent] };
        paragraph.content.splice(parsedIndex, 0, newRun);
        lastConsumedRun = newRun;
        parsedIndex++;
      }
    }

    if (hasNonTextBoxContent && parsedRun) {
      lastConsumedRun = parsedRun;
      parsedIndex++;
    }
  }
}

type TextBoxRunScan = {
  textBoxDrawings: XmlElement[];
  hasNonTextBoxContent: boolean;
};

function scanRunForTextBoxDrawings(xmlRun: XmlElement): TextBoxRunScan {
  const textBoxDrawings: XmlElement[] = [];
  let hasNonTextBoxContent = false;

  const visitDrawing = (drawingEl: XmlElement): void => {
    if (isTextBoxDrawing(drawingEl)) {
      textBoxDrawings.push(drawingEl);
      return;
    }
    hasNonTextBoxContent = true;
  };

  for (const el of getChildElements(xmlRun)) {
    const name = getLocalName(el.name ?? "");
    if (name === "rPr") {
      continue;
    }
    if (name === "drawing") {
      visitDrawing(el);
      continue;
    }
    if (name === "AlternateContent") {
      // Word stores anchored wps:wsp text boxes inside mc:AlternateContent —
      // Choice Requires="wps" holds the modern shape, Fallback holds a VML
      // rendering. Prefer Choice; if it has no drawing, fall back to Fallback
      // so we keep some shape data either way (matches the run-content parser).
      const branches = getChildElements(el);
      const choice = branches.find(
        (b) => getLocalName(b.name ?? "") === "Choice",
      );
      const fallback = branches.find(
        (b) => getLocalName(b.name ?? "") === "Fallback",
      );
      const tryBranch = (branch: XmlElement | undefined): boolean => {
        if (!branch) {
          return false;
        }
        let found = false;
        for (const innerEl of getChildElements(branch)) {
          if (getLocalName(innerEl.name ?? "") === "drawing") {
            visitDrawing(innerEl);
            found = true;
          }
        }
        return found;
      };
      let foundInBranch = tryBranch(choice);
      if (!foundInBranch) {
        foundInBranch = tryBranch(fallback);
      }
      if (!foundInBranch) {
        hasNonTextBoxContent = true;
      }
      continue;
    }
    hasNonTextBoxContent = true;
  }

  return { textBoxDrawings, hasNonTextBoxContent };
}

// ============================================================================
// CONTENT PARSING
// ============================================================================

/**
 * Parse block content from an element (body or SDT content)
 *
 * @param parent - Parent element containing content
 * @param styles - Style map
 * @param theme - Theme
 * @param numbering - Numbering definitions
 * @param rels - Relationships
 * @param media - Media files
 * @returns Array of block content (paragraphs, tables)
 */
function parseBlockContent(
  parent: XmlElement,
  styles: StyleMap | null,
  theme: Theme | null,
  numbering: NumberingMap | null,
  rels: RelationshipMap | null,
  media: Map<string, MediaFile> | null,
): BlockContent[] {
  const content: BlockContent[] = [];
  const children = getChildElements(parent);

  // Track list counters for computing markers
  // Map: numId -> array of counters for each level
  const listCounters = new Map<number, number[]>();
  const abstractCounters = new Map<number, number[]>();

  for (const child of children) {
    const name = child.name ?? "";

    // Paragraph (w:p)
    if (name === "w:p" || name.endsWith(":p")) {
      const paragraph = parseParagraph(
        child,
        styles,
        theme,
        numbering,
        rels,
        media,
      );
      // Enrich with text box content (parsed in a second pass to avoid circular deps)
      enrichParagraphTextBoxes(
        paragraph,
        child,
        styles,
        theme,
        numbering,
        rels,
        media,
      );
      // Compute list marker if this is a list item
      computeListMarker(paragraph, numbering, listCounters, abstractCounters);
      content.push(paragraph);
    }
    // Table (w:tbl)
    else if (name === "w:tbl" || name.endsWith(":tbl")) {
      const table = parseTable(child, styles, theme, numbering, rels, media);
      content.push(table);
    }
    // Structured Document Tag (w:sdt) - container for content
    else if (name === "w:sdt" || name.endsWith(":sdt")) {
      // Find the content element inside SDT
      const sdtContent = (child.elements ?? []).find(
        (el: XmlElement) =>
          el.type === "element" &&
          (el.name === "w:sdtContent" || el.name?.endsWith(":sdtContent")),
      );
      if (sdtContent) {
        // Recursively parse content inside SDT
        const sdtBlockContent = parseBlockContent(
          sdtContent,
          styles,
          theme,
          numbering,
          rels,
          media,
        );
        content.push(...sdtBlockContent);
      }
    }
    // Section properties (w:sectPr) - handled separately at body level
    // Skip here as we handle it after content parsing
  }

  return content;
}

// ============================================================================
// SECTION BUILDING
// ============================================================================

/**
 * Build sections from content based on section properties in paragraphs
 *
 * In OOXML, sections are delimited by:
 * 1. w:pPr/w:sectPr within a paragraph (marks end of a section)
 * 2. w:body/w:sectPr (final section properties)
 *
 * @param content - All block content
 * @param finalSectPr - Final section properties from body
 * @returns Array of sections
 */
function buildSections(
  content: BlockContent[],
  finalSectPr: SectionProperties | undefined,
): Section[] {
  const sections: Section[] = [];
  let currentSectionContent: BlockContent[] = [];

  for (const block of content) {
    currentSectionContent.push(block);

    // Check if this paragraph ends a section
    if (block.type === "paragraph" && block.sectionProperties) {
      // This paragraph ends a section
      sections.push({
        properties: block.sectionProperties,
        content: currentSectionContent,
      });

      // Start new section
      currentSectionContent = [];
    }
  }

  // Add final section with remaining content
  if (currentSectionContent.length > 0 || sections.length === 0) {
    sections.push({
      properties: finalSectPr ?? getDefaultSectionProperties(),
      content: currentSectionContent,
    });
  }

  return sections;
}

// ============================================================================
// MAIN PARSER
// ============================================================================

/**
 * Parse document.xml body content
 *
 * @param xml - Raw XML content of document.xml
 * @param styles - Parsed style map
 * @param theme - Parsed theme
 * @param numbering - Parsed numbering definitions
 * @param rels - Document relationships
 * @param media - Media files
 * @returns DocumentBody with content, sections, and template variables
 */
export function parseDocumentBody(
  xml: string,
  styles: StyleMap | null = null,
  theme: Theme | null = null,
  numbering: NumberingMap | null = null,
  rels: RelationshipMap | null = null,
  media: Map<string, MediaFile> | null = null,
): DocumentBody {
  const result: DocumentBody = {
    content: [],
  };

  if (!xml) {
    return result;
  }

  // Parse XML
  const doc = parseXml(xml);

  // Find root document element (w:document)
  const documentEl = (doc.elements ?? []).find(
    (el: XmlElement) =>
      el.type === "element" &&
      (el.name === "w:document" || el.name?.endsWith(":document")),
  );
  if (!documentEl) {
    return result;
  }

  // Find body element (w:body)
  const bodyEl = findChild(documentEl, "w", "body");
  if (!bodyEl) {
    return result;
  }

  // Parse all block content (paragraphs, tables)
  result.content = parseBlockContent(
    bodyEl,
    styles,
    theme,
    numbering,
    rels,
    media,
  );

  // Parse final section properties (w:body/w:sectPr)
  const finalSectPr = findChild(bodyEl, "w", "sectPr");
  if (finalSectPr) {
    result.finalSectionProperties = parseSectionProperties(finalSectPr, rels);
  }

  // Build sections from content
  result.sections = buildSections(
    result.content,
    result.finalSectionProperties,
  );

  return result;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get all paragraphs from document body (flattened)
 */
export function getAllParagraphs(body: DocumentBody): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  for (const block of body.content) {
    if (block.type === "paragraph") {
      paragraphs.push(block);
    } else if (block.type === "table") {
      // Get paragraphs from table cells
      paragraphs.push(...getTableParagraphs(block));
    }
  }

  return paragraphs;
}

/**
 * Get all paragraphs from a table (recursively)
 */
function getTableParagraphs(table: Table): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  for (const row of table.rows) {
    for (const cell of row.cells) {
      for (const content of cell.content) {
        if (content.type === "paragraph") {
          paragraphs.push(content);
        } else {
          paragraphs.push(...getTableParagraphs(content));
        }
      }
    }
  }

  return paragraphs;
}

/**
 * Get all tables from document body
 */
export function getAllTables(body: DocumentBody): Table[] {
  const tables: Table[] = [];

  for (const block of body.content) {
    if (block.type === "table") {
      tables.push(block);
      // Also get nested tables
      tables.push(...getNestedTables(block));
    }
  }

  return tables;
}

/**
 * Get nested tables from a table (recursively)
 */
function getNestedTables(table: Table): Table[] {
  const tables: Table[] = [];

  for (const row of table.rows) {
    for (const cell of row.cells) {
      for (const content of cell.content) {
        if (content.type === "table") {
          tables.push(content);
          tables.push(...getNestedTables(content));
        }
      }
    }
  }

  return tables;
}

/**
 * Get plain text from entire document body
 */
export function getDocumentText(body: DocumentBody): string {
  const lines: string[] = [];

  for (const block of body.content) {
    if (block.type === "paragraph") {
      lines.push(getParagraphText(block));
    } else if (block.type === "table") {
      lines.push(getTableText(block));
    }
  }

  return lines.join("\n");
}

/**
 * Get plain text from a table
 */
function getTableText(table: Table): string {
  const lines: string[] = [];

  for (const row of table.rows) {
    const rowTexts: string[] = [];
    for (const cell of row.cells) {
      const cellTexts: string[] = [];
      for (const content of cell.content) {
        if (content.type === "paragraph") {
          cellTexts.push(getParagraphText(content));
        } else {
          cellTexts.push(getTableText(content));
        }
      }
      rowTexts.push(cellTexts.join("\n"));
    }
    lines.push(rowTexts.join("\t"));
  }

  return lines.join("\n");
}

/**
 * Count total paragraphs in document
 */
export function getParagraphCount(body: DocumentBody): number {
  return getAllParagraphs(body).length;
}

/**
 * Count total words in document (approximate)
 */
export function getWordCount(body: DocumentBody): number {
  const text = getDocumentText(body);
  // Simple word counting - split by whitespace
  const words = text.trim().split(/\s+/u);
  return words.length > 0 && words[0] !== "" ? words.length : 0;
}

/**
 * Count total characters in document
 */
export function getCharacterCount(body: DocumentBody): number {
  return getDocumentText(body).length;
}

/**
 * Get section count
 */
export function getSectionCount(body: DocumentBody): number {
  return body.sections?.length ?? 1;
}

/**
 * Check if document has template variables
 */
export function hasTemplateVariables(body: DocumentBody): boolean {
  return extractAllTemplateVariables(body.content).length > 0;
}
