/**
 * Main Parser Orchestrator - Unified parseDocx function
 *
 * Coordinates all sub-parsers to produce a complete Document model.
 * Handles loading order, dependency resolution, and font preloading.
 *
 * Parsing order:
 * 1. Unzip DOCX package
 * 2. Parse relationships
 * 3. Parse theme (needed for style color/font resolution)
 * 4. Parse styles (depends on theme)
 * 5. Parse numbering
 * 6. Parse document body (depends on styles, theme, numbering, rels)
 * 7. Parse headers/footers (depends on styles, theme, numbering, rels)
 * 8. Parse footnotes/endnotes (depends on styles, theme, numbering, rels)
 * 9. Extract and load fonts
 * 10. Build media file map
 * 11. Assemble final Document
 */

import { TaggedError } from "better-result";

import type {
  Document,
  DocxPackage,
  DocumentBody,
  Theme,
  Footnote,
  Endnote,
  HeaderFooter,
  RelationshipMap,
  MediaFile,
  StyleDefinitions,
} from "../types/document";
import { toArrayBuffer } from "../utils/docxInput";
import type { DocxInput } from "../utils/docxInput";
import { loadFontsWithMapping } from "../utils/fontLoader";
import {
  convertTiffToPngDataUrl,
  isTiffMimeType,
} from "../utils/tiffConverter";
import { parseComments } from "./commentParser";
import { normalizeCommentReferences } from "./commentReferenceNormalization";
import {
  parseDocumentBody,
  extractAllTemplateVariables,
} from "./documentParser";
import { parseFootnotes, parseEndnotes } from "./footnoteParser";
import { parseHeader, parseFooter } from "./headerFooterParser";
import { normalizeHeaderFooterReferences } from "./headerFooterReferenceNormalization";
import {
  DocxModelValidationError,
  formatDocumentModelIssues,
  validateFolioDocumentModel,
} from "./modelValidation";
import { parseNumbering } from "./numberingParser";
import type { NumberingMap } from "./numberingParser";
import { normalizeNumberingReferences } from "./numberingReferenceNormalization";
import {
  parseRelationships,
  RELATIONSHIP_TYPES,
  resolveRelativePath,
} from "./relsParser";
import { parseStyles, parseStyleDefinitions } from "./styleParser";
import type { StyleMap } from "./styleParser";
import { parseTheme } from "./themeParser";
import { unzipDocx, getMediaMimeType, mediaToDataUrl } from "./unzip";
import type { DocxUnzipLimits, RawDocxContent } from "./unzip";

// ============================================================================
// PROGRESS CALLBACK
// ============================================================================

/**
 * Progress callback for tracking parsing stages
 */
export type ProgressCallback = (stage: string, percent: number) => void;

/**
 * Parsing options
 */
export type ParseOptions = {
  /** Progress callback for tracking parsing stages */
  onProgress?: ProgressCallback;
  /** Whether to preload fonts (default: true) */
  preloadFonts?: boolean;
  /** Whether to parse headers/footers (default: true) */
  parseHeadersFooters?: boolean;
  /** Whether to parse footnotes/endnotes (default: true) */
  parseNotes?: boolean;
  /** Whether to detect template variables (default: true) */
  detectVariables?: boolean;
  /** Security limits for DOCX ZIP extraction */
  unzipLimits?: Partial<Omit<DocxUnzipLimits, "allowedMediaMimeTypes">> & {
    allowedMediaMimeTypes?: Iterable<string>;
  };
};

// ============================================================================
// MAIN PARSER
// ============================================================================

/**
 * Parse a DOCX file into a complete Document model
 *
 * @param input - DOCX file as ArrayBuffer, Uint8Array, Blob, or File
 * @param options - Parsing options
 * @returns Promise resolving to Document
 * @throws Error if parsing fails
 */
export async function parseDocx(
  input: DocxInput,
  options: ParseOptions = {},
): Promise<Document> {
  // Normalize any supported input type to ArrayBuffer
  const buffer =
    input instanceof ArrayBuffer ? input : await toArrayBuffer(input);
  const {
    // oxlint-disable-next-line no-empty-function -- intentional no-op default
    onProgress = () => {},
    preloadFonts = true,
    parseHeadersFooters = true,
    parseNotes = true,
    detectVariables = true,
    unzipLimits,
  } = options;

  const warnings: string[] = [];

  try {
    // oxlint-disable-next-line no-inner-declarations -- scoped to try block intentionally
    function timeStage<T>(_name: string, fn: () => T): T {
      return fn();
    }

    // oxlint-disable-next-line no-inner-declarations -- scoped to try block intentionally
    async function timeStageAsync<T>(
      _name: string,
      fn: () => Promise<T>,
    ): Promise<T> {
      return await fn();
    }

    // ========================================================================
    // STAGE 1: Unzip DOCX package (0-10%)
    // ========================================================================
    onProgress("Extracting DOCX...", 0);
    const raw = await timeStageAsync("unzip", () =>
      unzipDocx(buffer, unzipLimits),
    );
    onProgress("Extracted DOCX", 10);

    // ========================================================================
    // STAGE 2: Parse relationships (10-15%)
    // ========================================================================
    onProgress("Parsing relationships...", 10);
    const rels = timeStage("relationships", () =>
      raw.documentRels ? parseRelationships(raw.documentRels) : new Map(),
    );
    onProgress("Parsed relationships", 15);

    // ========================================================================
    // STAGE 3: Parse theme (15-20%)
    // ========================================================================
    onProgress("Parsing theme...", 15);
    const theme = timeStage("theme", () => parseTheme(raw.themeXml));
    onProgress("Parsed theme", 20);

    // ========================================================================
    // STAGE 4: Parse styles (20-30%)
    // ========================================================================
    onProgress("Parsing styles...", 20);
    let styles: StyleMap | null = null;
    let styleDefinitions: StyleDefinitions | undefined;

    timeStage("styles", () => {
      if (raw.stylesXml) {
        styles = parseStyles(raw.stylesXml, theme);
        styleDefinitions = parseStyleDefinitions(raw.stylesXml, theme);
      }
    });
    onProgress("Parsed styles", 30);

    // ========================================================================
    // STAGE 5: Parse numbering (30-35%)
    // ========================================================================
    onProgress("Parsing numbering...", 30);
    const numbering = timeStage("numbering", () =>
      parseNumbering(raw.numberingXml),
    );
    onProgress("Parsed numbering", 35);

    // ========================================================================
    // STAGE 6: Build media file map (35-40%)
    // ========================================================================
    onProgress("Processing media files...", 35);
    const media = timeStage("media", () => buildMediaMap(raw, rels));
    onProgress("Processed media", 40);

    // ========================================================================
    // STAGE 7: Parse document body (40-55%)
    // ========================================================================
    onProgress("Parsing document body...", 40);
    let documentBody: DocumentBody = { content: [] };

    timeStage("documentBody", () => {
      if (raw.documentXml) {
        documentBody = parseDocumentBody(
          raw.documentXml,
          styles,
          theme,
          numbering,
          rels,
          media,
        );
      } else {
        warnings.push("No document.xml found in DOCX");
      }
    });
    onProgress("Parsed document body", 55);

    // ========================================================================
    // STAGE 8: Parse headers/footers (55-65%)
    // ========================================================================
    let headers: Map<string, HeaderFooter> | undefined;
    let footers: Map<string, HeaderFooter> | undefined;

    if (parseHeadersFooters) {
      onProgress("Parsing headers/footers...", 55);
      const hf = timeStage("headersFooters", () =>
        parseHeadersAndFooters(raw, styles, theme, numbering, rels, media),
      );
      headers = hf.headers;
      footers = hf.footers;
      onProgress("Parsed headers/footers", 65);
    } else {
      onProgress("Skipping headers/footers", 65);
    }

    // ========================================================================
    // STAGE 9: Parse footnotes/endnotes (65-75%)
    // ========================================================================
    let footnotes: Footnote[] | undefined;
    let endnotes: Endnote[] | undefined;

    if (parseNotes) {
      onProgress("Parsing footnotes/endnotes...", 65);
      const notes = timeStage("footnotesEndnotes", () =>
        parseNotesContent(raw, styles, theme, numbering, rels, media),
      );
      footnotes = notes.footnotes;
      endnotes = notes.endnotes;
      onProgress("Parsed footnotes/endnotes", 75);
    } else {
      onProgress("Skipping footnotes/endnotes", 75);
    }

    // ========================================================================
    // STAGE 9b: Parse comments (75-77%)
    // ========================================================================
    onProgress("Parsing comments...", 75);
    const comments = timeStage("comments", () =>
      parseComments(
        raw.commentsXml,
        styles,
        theme,
        rels,
        media,
        raw.commentsExtensibleXml,
        raw.commentsExtendedXml,
      ),
    );
    if (comments.length > 0) {
      documentBody.comments = comments;
    }
    const commentReferenceNormalization = normalizeCommentReferences({
      documentBody,
      comments,
      ...(headers !== undefined ? { headers } : {}),
      ...(footers !== undefined ? { footers } : {}),
      ...(footnotes !== undefined ? { footnotes } : {}),
      ...(endnotes !== undefined ? { endnotes } : {}),
    });
    if (commentReferenceNormalization.removedDanglingReferences > 0) {
      warnings.push(
        `Removed ${commentReferenceNormalization.removedDanglingReferences} dangling comment reference marker(s) whose comments.xml entries are missing.`,
      );
    }
    if (commentReferenceNormalization.reanchoredUnbalancedRanges > 0) {
      warnings.push(
        `Re-anchored ${commentReferenceNormalization.reanchoredUnbalancedRanges} unbalanced comment range marker(s) as point comments.`,
      );
    }
    const headerFooterReferenceNormalization = normalizeHeaderFooterReferences({
      documentBody,
      ...(headers !== undefined ? { headers } : {}),
      ...(footers !== undefined ? { footers } : {}),
    });
    if (
      headerFooterReferenceNormalization.removedDanglingHeaderReferences > 0
    ) {
      warnings.push(
        `Removed ${headerFooterReferenceNormalization.removedDanglingHeaderReferences} dangling header reference(s) whose header parts are missing.`,
      );
    }
    if (
      headerFooterReferenceNormalization.removedDanglingFooterReferences > 0
    ) {
      warnings.push(
        `Removed ${headerFooterReferenceNormalization.removedDanglingFooterReferences} dangling footer reference(s) whose footer parts are missing.`,
      );
    }
    const numberingReferenceNormalization = normalizeNumberingReferences({
      documentBody,
      numbering,
      ...(headers !== undefined ? { headers } : {}),
      ...(footers !== undefined ? { footers } : {}),
      ...(footnotes !== undefined ? { footnotes } : {}),
      ...(endnotes !== undefined ? { endnotes } : {}),
    });
    if (numberingReferenceNormalization.removedMissingNumberingReferences > 0) {
      warnings.push(
        `Removed ${numberingReferenceNormalization.removedMissingNumberingReferences} numbering reference(s) whose numbering definitions are missing.`,
      );
    }

    // ========================================================================
    // STAGE 10: Detect template variables (77-80%)
    // ========================================================================
    let templateVariables: string[] | undefined;

    if (detectVariables) {
      onProgress("Detecting template variables...", 75);
      templateVariables = timeStage("variables", () =>
        extractAllTemplateVariables(documentBody.content),
      );
      onProgress("Detected variables", 80);
    } else {
      onProgress("Skipping variable detection", 80);
    }

    // ========================================================================
    // STAGE 11: Extract fonts (80-90%) — loading is deferred to the component
    // ========================================================================
    onProgress("Extracting fonts...", 80);
    const requiredFonts = timeStage("fontExtract", () =>
      extractDocumentFontNames(theme, styleDefinitions, documentBody),
    );
    onProgress("Extracted fonts", 90);

    if (preloadFonts) {
      onProgress("Loading fonts...", 90);
      await timeStageAsync("fonts", () => loadFontsWithMapping(requiredFonts));
      onProgress("Loaded fonts", 95);
    } else {
      onProgress("Skipping font loading", 95);
    }

    // ========================================================================
    // STAGE 12: Assemble final Document (95-100%)
    // ========================================================================
    onProgress("Assembling document...", 95);

    const pkg: DocxPackage = {
      document: documentBody,
      ...(styleDefinitions !== undefined ? { styles: styleDefinitions } : {}),
      theme,
      numbering: numbering.definitions,
      ...(headers !== undefined ? { headers } : {}),
      ...(footers !== undefined ? { footers } : {}),
      ...(footnotes !== undefined ? { footnotes } : {}),
      ...(endnotes !== undefined ? { endnotes } : {}),
      relationships: rels,
      media,
    };

    const document: Document = {
      package: pkg,
      originalBuffer: raw.originalBuffer,
      ...(templateVariables !== undefined ? { templateVariables } : {}),
      ...(requiredFonts.length > 0 ? { requiredFonts } : {}),
    };

    const validation = validateFolioDocumentModel(document);
    const parsedCompleteModel = parseHeadersFooters && parseNotes;
    if (!validation.valid && parsedCompleteModel) {
      throw new DocxModelValidationError(
        "Parsed DOCX produced an invalid document model",
        validation.issues,
      );
    }
    warnings.push(...formatDocumentModelIssues(validation.issues));
    if (warnings.length > 0) {
      document.warnings = warnings;
    }

    onProgress("Complete", 100);
    return document;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DocxParseError({
      message: `Failed to parse DOCX: ${message}`,
      cause: error,
    });
  }
}

/** DOCX parsing failure: malformed package, unsupported feature, or
 *  upstream parser exception. Wraps the original cause for diagnostics. */
export class DocxParseError extends TaggedError("DocxParseError")<{
  message: string;
  cause?: unknown;
}>() {}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Build media file map from raw content and relationships
 */
function buildMediaMap(
  raw: RawDocxContent,
  _rels: RelationshipMap,
): Map<string, MediaFile> {
  const media = new Map<string, MediaFile>();

  // Process each media file
  for (const [path, data] of raw.media.entries()) {
    const filename = path.split("/").pop() || path;
    const mimeType = getMediaMimeType(path);

    // TIFF: browsers don't render TIFF in <img>, so decode + re-encode as
    // PNG eagerly. The mimeType, data, and filename extension are all
    // updated together so re-export writes a PNG file matching its
    // declared type. If conversion fails (e.g. headless / no Canvas, or
    // dimensions exceed the safety cap), fall through to lazy attachment
    // with the original TIFF data — the round-trip survives even if the
    // in-browser preview is broken.
    if (isTiffMimeType(mimeType)) {
      const converted = convertTiffToPngDataUrl(data);
      if (converted) {
        const mediaFile: MediaFile = {
          path,
          filename: filename.replace(/\.tiff?$/iu, ".png"),
          mimeType: "image/png",
          data: converted.data,
          dataUrl: converted.dataUrl,
        };
        media.set(path, mediaFile);
        const normalizedPath = path.replace(/^word\//u, "");
        if (normalizedPath !== path) {
          media.set(normalizedPath, mediaFile);
        }
        continue;
      }
    }

    const mediaFile: MediaFile = {
      path,
      filename,
      mimeType,
      data,
    };
    attachLazyDataUrl(mediaFile);

    // Store by path and also by relationship target path
    media.set(path, mediaFile);

    // Also map normalized paths (without "word/" prefix)
    const normalizedPath = path.replace(/^word\//u, "");
    if (normalizedPath !== path) {
      media.set(normalizedPath, mediaFile);
    }
  }

  return media;
}

function attachLazyDataUrl(mediaFile: MediaFile): void {
  let cachedDataUrl: string | undefined;
  Object.defineProperty(mediaFile, "dataUrl", {
    configurable: true,
    enumerable: false,
    get() {
      cachedDataUrl ??= mediaToDataUrl(mediaFile.data, mediaFile.mimeType);
      return cachedDataUrl;
    },
  });
}

/**
 * Parse headers and footers from raw content
 */
/**
 * Case-insensitive lookup in a Map
 * ZIP files may have inconsistent casing for paths/filenames
 */
function getMapCaseInsensitive<T>(
  map: Map<string, T>,
  targetKey: string,
): T | undefined {
  const lowerTarget = targetKey.toLowerCase();
  for (const [key, value] of map.entries()) {
    if (key.toLowerCase() === lowerTarget) {
      return value;
    }
  }
  return undefined;
}

const DOCUMENT_RELATIONSHIPS_PATH = "word/_rels/document.xml.rels";

function getRelationshipPartPath(target: string): string {
  return resolveRelativePath(DOCUMENT_RELATIONSHIPS_PATH, target);
}

function getRelationshipsPathForPart(partPath: string): string {
  const lastSlash = partPath.lastIndexOf("/");
  const directory = lastSlash === -1 ? "" : partPath.slice(0, lastSlash);
  const filename = lastSlash === -1 ? partPath : partPath.slice(lastSlash + 1);
  return `${directory ? `${directory}/` : ""}_rels/${filename}.rels`;
}

function getHeaderFooterXml(
  raw: RawDocxContent,
  partPath: string,
  indexedParts: Map<string, string>,
): string | undefined {
  const filename = partPath.split("/").pop() ?? partPath;
  return (
    getMapCaseInsensitive(indexedParts, filename) ??
    getMapCaseInsensitive(raw.allXml, partPath)
  );
}

function parseHeadersAndFooters(
  raw: RawDocxContent,
  styles: StyleMap | null,
  theme: Theme | null,
  numbering: NumberingMap | null,
  rels: RelationshipMap,
  media: Map<string, MediaFile>,
): { headers: Map<string, HeaderFooter>; footers: Map<string, HeaderFooter> } {
  const headers = new Map<string, HeaderFooter>();
  const footers = new Map<string, HeaderFooter>();

  // We need to map the relationship IDs to header/footer files
  // The relationships tell us which rId maps to which header/footer file

  // Find header/footer references in relationships
  for (const [rId, rel] of rels.entries()) {
    if (rel.type === RELATIONSHIP_TYPES.header && rel.target) {
      // Get the header XML for this relationship
      // Use case-insensitive lookup since ZIP files may have inconsistent casing
      const partPath = getRelationshipPartPath(rel.target);
      const headerXml = getHeaderFooterXml(raw, partPath, raw.headers);

      if (headerXml) {
        // Get header-specific relationships (e.g., word/_rels/header1.xml.rels)
        const headerRelsPath = getRelationshipsPathForPart(partPath);
        const headerRelsXml = getMapCaseInsensitive(raw.allXml, headerRelsPath);
        const headerRels = headerRelsXml
          ? parseRelationships(headerRelsXml)
          : rels;

        const header = parseHeader(
          headerXml,
          "default", // We'll update this based on sectPr references
          styles,
          theme,
          numbering,
          headerRels,
          media,
        );
        headers.set(rId, header);
      }
    } else if (rel.type === RELATIONSHIP_TYPES.footer && rel.target) {
      // Use case-insensitive lookup since ZIP files may have inconsistent casing
      const partPath = getRelationshipPartPath(rel.target);
      const footerXml = getHeaderFooterXml(raw, partPath, raw.footers);

      if (footerXml) {
        // Get footer-specific relationships (e.g., word/_rels/footer1.xml.rels)
        const footerRelsPath = getRelationshipsPathForPart(partPath);
        const footerRelsXml = getMapCaseInsensitive(raw.allXml, footerRelsPath);
        const footerRels = footerRelsXml
          ? parseRelationships(footerRelsXml)
          : rels;

        const footer = parseFooter(
          footerXml,
          "default",
          styles,
          theme,
          numbering,
          footerRels,
          media,
        );
        footers.set(rId, footer);
      }
    }
  }

  return { headers, footers };
}

/**
 * Parse footnotes and endnotes from raw content
 */
function parseNotesContent(
  raw: RawDocxContent,
  styles: StyleMap | null,
  theme: Theme | null,
  numbering: NumberingMap | null,
  rels: RelationshipMap,
  media: Map<string, MediaFile>,
): { footnotes: Footnote[]; endnotes: Endnote[] } {
  const footnoteMap = parseFootnotes(
    raw.footnotesXml,
    styles,
    theme,
    numbering,
    rels,
    media,
  );

  const endnoteMap = parseEndnotes(
    raw.endnotesXml,
    styles,
    theme,
    numbering,
    rels,
    media,
  );

  return {
    footnotes: footnoteMap.getNormalFootnotes(),
    endnotes: endnoteMap.getNormalEndnotes(),
  };
}

/**
 * Extract all font family names referenced in the document (synchronous, no network).
 * Returns a deduplicated array suitable for passing to `loadFontsWithMapping`.
 */
function extractDocumentFontNames(
  theme: Theme | null,
  styleDefinitions: StyleDefinitions | undefined,
  documentBody: DocumentBody,
): string[] {
  const docxFonts = new Set<string>();

  // Extract fonts from theme
  if (theme?.fontScheme) {
    const { majorFont, minorFont } = theme.fontScheme;
    if (majorFont?.latin) {
      docxFonts.add(majorFont.latin);
    }
    if (minorFont?.latin) {
      docxFonts.add(minorFont.latin);
    }
  }

  // Extract fonts from style defaults
  if (styleDefinitions?.docDefaults?.rPr?.fontFamily?.ascii) {
    docxFonts.add(styleDefinitions.docDefaults.rPr.fontFamily.ascii);
  }

  // Extract fonts from styles
  if (styleDefinitions?.styles) {
    for (const style of styleDefinitions.styles) {
      if (style.rPr?.fontFamily?.ascii) {
        docxFonts.add(style.rPr.fontFamily.ascii);
      }
      if (style.rPr?.fontFamily?.hAnsi) {
        docxFonts.add(style.rPr.fontFamily.hAnsi);
      }
    }
  }

  // Extract fonts from document content (inline run formatting)
  for (const block of documentBody.content) {
    if (block.type === "paragraph") {
      for (const item of block.content) {
        if (item.type === "run" && item.formatting?.fontFamily) {
          if (item.formatting.fontFamily.ascii) {
            docxFonts.add(item.formatting.fontFamily.ascii);
          }
          if (item.formatting.fontFamily.hAnsi) {
            docxFonts.add(item.formatting.fontFamily.hAnsi);
          }
        }
      }
    }
  }

  return Array.from(docxFonts);
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Quick parse - parse a DOCX without font loading
 * Useful for quick content extraction or when fonts aren't needed
 */
export function quickParseDocx(buffer: ArrayBuffer): Promise<Document> {
  return parseDocx(buffer, {
    preloadFonts: false,
    parseHeadersFooters: false,
    parseNotes: false,
    detectVariables: true,
  });
}

/**
 * Full parse - parse everything including fonts
 */
export function fullParseDocx(
  buffer: ArrayBuffer,
  onProgress?: ProgressCallback,
): Promise<Document> {
  return parseDocx(buffer, {
    ...(onProgress !== undefined ? { onProgress } : {}),
    preloadFonts: true,
    parseHeadersFooters: true,
    parseNotes: true,
    detectVariables: true,
  });
}

/**
 * Get template variables from a DOCX without full parsing
 * Faster than full parse when you only need variables
 */
export async function getDocxVariables(buffer: ArrayBuffer): Promise<string[]> {
  const raw = await unzipDocx(buffer);

  if (!raw.documentXml) {
    return [];
  }

  // Quick parse just the document body
  const documentBody = parseDocumentBody(raw.documentXml);
  return extractAllTemplateVariables(documentBody.content);
}

/**
 * Get document summary without full parsing
 */
export async function getDocxSummary(buffer: ArrayBuffer): Promise<{
  hasDocument: boolean;
  hasStyles: boolean;
  hasTheme: boolean;
  hasNumbering: boolean;
  headerCount: number;
  footerCount: number;
  mediaCount: number;
  variableCount: number;
}> {
  const raw = await unzipDocx(buffer);
  const variables = raw.documentXml
    ? extractAllTemplateVariables(parseDocumentBody(raw.documentXml).content)
    : [];

  return {
    hasDocument: raw.documentXml !== null,
    hasStyles: raw.stylesXml !== null,
    hasTheme: raw.themeXml !== null,
    hasNumbering: raw.numberingXml !== null,
    headerCount: raw.headers.size,
    footerCount: raw.footers.size,
    mediaCount: raw.media.size,
    variableCount: variables.length,
  };
}
