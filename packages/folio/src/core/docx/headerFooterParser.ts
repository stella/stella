/**
 * Header/Footer Parser - Parse header*.xml and footer*.xml files
 *
 * Headers and footers are stored in separate XML files within the DOCX package:
 * - word/header1.xml, word/header2.xml, etc.
 * - word/footer1.xml, word/footer2.xml, etc.
 *
 * Each header/footer is referenced from document.xml via:
 * - w:sectPr > w:headerReference (type="default|first|even", r:id="rIdX")
 * - w:sectPr > w:footerReference (type="default|first|even", r:id="rIdX")
 *
 * Header/footer types:
 * - default: Used for all pages unless first/even specified
 * - first: Used only for the first page of a section
 * - even: Used for even-numbered pages (when different odd/even enabled)
 *
 * Content structure:
 * - w:hdr or w:ftr root element
 * - Contains w:p (paragraphs), w:tbl (tables), and w:sdt containers
 * - Can contain images, shapes, text boxes, page numbers, etc.
 *
 * Header/footer content uses the same OOXML block model as the document body,
 * so it goes through the shared block-content parser instead of a body-only
 * subset.
 *
 * OOXML Reference:
 * - Root: w:hdr (header) or w:ftr (footer)
 * - Content: w:p, w:tbl
 */

import type {
  HeaderFooter,
  HeaderFooterType,
  HeaderReference,
  FooterReference,
  Theme,
  RelationshipMap,
  MediaFile,
} from "../types/document";
import { parseBlockContent } from "./blockContentParser";
import type { NumberingMap } from "./numberingParser";
import type { StyleMap } from "./styleParser";
import { parseXml } from "./xmlParser";
import type { XmlElement } from "./xmlParser";

// Re-export reference parsers for backward compatibility
export {
  parseHeaderReference,
  parseFooterReference,
  parseHeaderReferences,
  parseFooterReferences,
} from "./headerFooterRefParser";

// ============================================================================
// HEADER/FOOTER MAP INTERFACE
// ============================================================================

/**
 * Map of header/footer ID to HeaderFooter content
 */
export type HeaderFooterMap = {
  /** Map of rId to HeaderFooter */
  byId: Map<string, HeaderFooter>;

  /** Get header/footer by rId */
  get(rId: string): HeaderFooter | undefined;

  /** Check if header/footer exists */
  has(rId: string): boolean;

  /** Get all headers/footers */
  getAll(): HeaderFooter[];

  /** Get by type */
  getByType(type: HeaderFooterType): HeaderFooter | undefined;
};

/**
 * Parse a header XML file (word/header*.xml)
 *
 * @param headerXml - The raw XML content of the header file
 * @param hdrFtrType - The type of header (default, first, even)
 * @param styles - Parsed style map for applying styles
 * @param theme - Parsed theme for color resolution
 * @param numbering - Parsed numbering definitions for lists
 * @param rels - Relationships for resolving hyperlinks/images
 * @param media - Media files for images
 * @returns HeaderFooter object
 */
export function parseHeader(
  headerXml: string,
  hdrFtrType: HeaderFooterType = "default",
  styles: StyleMap | null = null,
  theme: Theme | null = null,
  numbering: NumberingMap | null = null,
  rels: RelationshipMap | null = null,
  media: Map<string, MediaFile> | null = null,
): HeaderFooter {
  const result: HeaderFooter = {
    type: "header",
    hdrFtrType,
    content: [],
  };

  if (!headerXml) {
    return result;
  }

  const doc = parseXml(headerXml);

  // Find the root header element (w:hdr)
  const rootElement = doc.elements?.find(
    (el: XmlElement) =>
      el.type === "element" &&
      (el.name === "w:hdr" || el.name?.endsWith(":hdr")),
  );

  if (!rootElement) {
    return result;
  }

  result.content = parseBlockContent(
    rootElement,
    styles,
    theme,
    numbering,
    rels,
    media,
    { inHeaderFooter: true },
  );

  return result;
}

/**
 * Parse a footer XML file (word/footer*.xml)
 *
 * @param footerXml - The raw XML content of the footer file
 * @param hdrFtrType - The type of footer (default, first, even)
 * @param styles - Parsed style map for applying styles
 * @param theme - Parsed theme for color resolution
 * @param numbering - Parsed numbering definitions for lists
 * @param rels - Relationships for resolving hyperlinks/images
 * @param media - Media files for images
 * @returns HeaderFooter object
 */
export function parseFooter(
  footerXml: string,
  hdrFtrType: HeaderFooterType = "default",
  styles: StyleMap | null = null,
  theme: Theme | null = null,
  numbering: NumberingMap | null = null,
  rels: RelationshipMap | null = null,
  media: Map<string, MediaFile> | null = null,
): HeaderFooter {
  const result: HeaderFooter = {
    type: "footer",
    hdrFtrType,
    content: [],
  };

  if (!footerXml) {
    return result;
  }

  const doc = parseXml(footerXml);

  // Find the root footer element (w:ftr)
  const rootElement = doc.elements?.find(
    (el: XmlElement) =>
      el.type === "element" &&
      (el.name === "w:ftr" || el.name?.endsWith(":ftr")),
  );

  if (!rootElement) {
    return result;
  }

  result.content = parseBlockContent(
    rootElement,
    styles,
    theme,
    numbering,
    rels,
    media,
    { inHeaderFooter: true },
  );

  return result;
}

/**
 * Generic function to parse either header or footer
 *
 * @param xml - Raw XML content
 * @param isHeader - true for header, false for footer
 * @param hdrFtrType - The type (default, first, even)
 * @param styles - Style map
 * @param theme - Theme
 * @param numbering - Numbering definitions
 * @param rels - Relationships
 * @param media - Media files
 * @returns HeaderFooter object
 */
export function parseHeaderFooter(
  xml: string,
  isHeader: boolean,
  hdrFtrType: HeaderFooterType = "default",
  styles: StyleMap | null = null,
  theme: Theme | null = null,
  numbering: NumberingMap | null = null,
  rels: RelationshipMap | null = null,
  media: Map<string, MediaFile> | null = null,
): HeaderFooter {
  if (isHeader) {
    return parseHeader(xml, hdrFtrType, styles, theme, numbering, rels, media);
  }
  return parseFooter(xml, hdrFtrType, styles, theme, numbering, rels, media);
}

// ============================================================================
// HEADER/FOOTER MAP CREATION
// ============================================================================

/**
 * Create a HeaderFooterMap from parsed headers/footers
 */
function createHeaderFooterMap(
  byId: Map<string, HeaderFooter>,
): HeaderFooterMap {
  return {
    byId,

    get(rId: string): HeaderFooter | undefined {
      return byId.get(rId);
    },

    has(rId: string): boolean {
      return byId.has(rId);
    },

    getAll(): HeaderFooter[] {
      return Array.from(byId.values());
    },

    getByType(type: HeaderFooterType): HeaderFooter | undefined {
      for (const hf of byId.values()) {
        if (hf.hdrFtrType === type) {
          return hf;
        }
      }
      return undefined;
    },
  };
}

/**
 * Create an empty HeaderFooterMap
 */
export function createEmptyHeaderFooterMap(): HeaderFooterMap {
  return createHeaderFooterMap(new Map());
}

/**
 * Build a HeaderFooterMap from references and XML content
 *
 * @param references - Header or footer references from sectPr
 * @param xmlContents - Map of rId to XML content
 * @param isHeader - true for headers, false for footers
 * @param styles - Style map
 * @param theme - Theme
 * @param numbering - Numbering definitions
 * @param rels - Relationships
 * @param media - Media files
 * @returns HeaderFooterMap with all parsed headers/footers
 */
export function buildHeaderFooterMap(
  references: (HeaderReference | FooterReference)[],
  xmlContents: Map<string, string>,
  isHeader: boolean,
  styles: StyleMap | null = null,
  theme: Theme | null = null,
  numbering: NumberingMap | null = null,
  rels: RelationshipMap | null = null,
  media: Map<string, MediaFile> | null = null,
): HeaderFooterMap {
  const byId = new Map<string, HeaderFooter>();

  for (const ref of references) {
    const xml = xmlContents.get(ref.rId);
    if (xml) {
      const hf = parseHeaderFooter(
        xml,
        isHeader,
        ref.type,
        styles,
        theme,
        numbering,
        rels,
        media,
      );
      byId.set(ref.rId, hf);
    }
  }

  return createHeaderFooterMap(byId);
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get plain text content of a header/footer
 */
export function getHeaderFooterText(hf: HeaderFooter): string {
  const texts: string[] = [];

  for (const item of hf.content) {
    if (item.type === "paragraph") {
      const paraTexts: string[] = [];
      for (const content of item.content) {
        if (content.type === "run") {
          for (const runContent of content.content) {
            if (runContent.type === "text") {
              paraTexts.push(runContent.text);
            }
          }
        }
      }
      texts.push(paraTexts.join(""));
    } else if (item.type === "blockSdt") {
      // The SDT wrapper is invisible to plain-text extraction; recurse via a
      // synthetic HeaderFooter so the existing per-block dispatch handles
      // the nested paragraphs/tables/SDTs without code duplication.
      texts.push(
        getHeaderFooterText({
          type: hf.type,
          hdrFtrType: hf.hdrFtrType,
          content: item.content,
        }),
      );
    } else {
      // Extract text from table cells
      for (const row of item.rows) {
        for (const cell of row.cells) {
          for (const cellContent of cell.content) {
            if (cellContent.type === "paragraph") {
              const paraTexts: string[] = [];
              for (const content of cellContent.content) {
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
          }
        }
      }
    }
  }

  return texts.join("\n");
}

/**
 * Check if header/footer is empty (no content)
 */
export function isEmptyHeaderFooter(hf: HeaderFooter): boolean {
  if (hf.content.length === 0) {
    return true;
  }

  // Check if all content is empty paragraphs
  for (const item of hf.content) {
    if (item.type === "table") {
      return false;
    }
    if (item.content.length > 0) {
      // Check if paragraph has any actual content
      for (const content of item.content) {
        if (content.type !== "run") {
          return false;
        }
        for (const rc of content.content) {
          if (rc.type === "text" && rc.text.length > 0) {
            return false;
          }
          if (rc.type !== "text") {
            return false;
          } // Has image, field, etc.
        }
      }
    }
  }

  return true;
}

/**
 * Check if header/footer has page number field
 */
export function hasPageNumberField(hf: HeaderFooter): boolean {
  for (const item of hf.content) {
    if (item.type === "paragraph") {
      for (const content of item.content) {
        if (
          (content.type === "simpleField" || content.type === "complexField") &&
          (content.fieldType === "PAGE" || content.fieldType === "NUMPAGES")
        ) {
          return true;
        }
        if (content.type === "run") {
          for (const rc of content.content) {
            if (rc.type === "fieldChar" && rc.charType === "begin") {
              // Part of a complex field - would need to check instruction
              // For simplicity, we'll check the field content in the paragraph
              continue;
            }
          }
        }
      }
    }
  }
  return false;
}

/**
 * Get the header for a given page considering type rules
 *
 * @param headers - Map of type to HeaderFooter
 * @param pageNumber - 1-based page number
 * @param isFirstPage - Whether this is the first page of the section
 * @param hasDifferentFirstPage - Whether different first page is enabled
 * @param hasDifferentOddEven - Whether different odd/even pages is enabled
 * @returns The appropriate HeaderFooter or undefined
 */
export function getHeaderForPage(
  headers: Map<HeaderFooterType, HeaderFooter>,
  pageNumber: number,
  isFirstPage: boolean,
  hasDifferentFirstPage: boolean,
  hasDifferentOddEven: boolean,
): HeaderFooter | undefined {
  // First page header takes priority if enabled
  if (isFirstPage && hasDifferentFirstPage) {
    const firstHeader = headers.get("first");
    if (firstHeader) {
      return firstHeader;
    }
  }

  // Even page header if enabled and page is even
  if (hasDifferentOddEven && pageNumber % 2 === 0) {
    const evenHeader = headers.get("even");
    if (evenHeader) {
      return evenHeader;
    }
  }

  // Default header for everything else
  return headers.get("default");
}

/**
 * Get the footer for a given page considering type rules
 * (Same logic as getHeaderForPage)
 */
export function getFooterForPage(
  footers: Map<HeaderFooterType, HeaderFooter>,
  pageNumber: number,
  isFirstPage: boolean,
  hasDifferentFirstPage: boolean,
  hasDifferentOddEven: boolean,
): HeaderFooter | undefined {
  if (isFirstPage && hasDifferentFirstPage) {
    const firstFooter = footers.get("first");
    if (firstFooter) {
      return firstFooter;
    }
  }

  if (hasDifferentOddEven && pageNumber % 2 === 0) {
    const evenFooter = footers.get("even");
    if (evenFooter) {
      return evenFooter;
    }
  }

  return footers.get("default");
}

/**
 * Convert HeaderFooterMap to type-indexed Map
 *
 * @param map - HeaderFooterMap
 * @returns Map indexed by HeaderFooterType
 */
export function headerFooterMapToTypeMap(
  map: HeaderFooterMap,
): Map<HeaderFooterType, HeaderFooter> {
  const result = new Map<HeaderFooterType, HeaderFooter>();

  for (const hf of map.getAll()) {
    // If there are multiple with same type, later ones overwrite
    result.set(hf.hdrFtrType, hf);
  }

  return result;
}

/**
 * Check if a HeaderFooter contains any images
 */
export function hasImages(hf: HeaderFooter): boolean {
  for (const item of hf.content) {
    if (item.type === "paragraph") {
      for (const content of item.content) {
        if (content.type === "run") {
          for (const rc of content.content) {
            if (rc.type === "drawing") {
              return true;
            }
          }
        }
      }
    }
  }
  return false;
}

/**
 * Check if a HeaderFooter contains any tables
 */
export function hasTables(hf: HeaderFooter): boolean {
  for (const item of hf.content) {
    if (item.type === "table") {
      return true;
    }
  }
  return false;
}
