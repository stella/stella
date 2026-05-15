/**
 * DOCX Unzipper
 *
 * Extracts all files from a DOCX ZIP archive and organizes them
 * into a structured format for further processing.
 *
 * A DOCX file is a ZIP archive containing:
 * - [Content_Types].xml - Content type declarations
 * - word/document.xml - Main document content
 * - word/styles.xml - Style definitions
 * - word/theme/theme1.xml - Theme colors and fonts
 * - word/numbering.xml - List/numbering definitions
 * - word/fontTable.xml - Font declarations
 * - word/settings.xml - Document settings
 * - word/webSettings.xml - Web settings
 * - word/header*.xml - Header content
 * - word/footer*.xml - Footer content
 * - word/footnotes.xml - Footnotes
 * - word/endnotes.xml - Endnotes
 * - word/media/* - Embedded images and media
 * - word/_rels/document.xml.rels - Relationships
 * - _rels/.rels - Package relationships
 * - docProps/core.xml - Core properties
 * - docProps/app.xml - Application properties
 */

import JSZip from "jszip";

export class DocxSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocxSecurityError";
  }
}

export type DocxUnzipLimits = {
  maxInputBytes: number;
  maxFiles: number;
  maxXmlBytes: number;
  maxMediaBytes: number;
  maxFontBytes: number;
  maxTotalUncompressedBytes: number;
  allowedMediaMimeTypes: ReadonlySet<string>;
};

const DEFAULT_ALLOWED_MEDIA_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/webp",
]);

const PRESERVABLE_MEDIA_MIME_TYPES = new Set([
  ...DEFAULT_ALLOWED_MEDIA_MIME_TYPES,
  "image/svg+xml",
  "image/x-wmf",
  "image/x-emf",
]);

const DEFAULT_UNZIP_LIMITS: DocxUnzipLimits = {
  maxInputBytes: 50 * 1024 * 1024,
  maxFiles: 2000,
  maxXmlBytes: 25 * 1024 * 1024,
  maxMediaBytes: 25 * 1024 * 1024,
  maxFontBytes: 10 * 1024 * 1024,
  maxTotalUncompressedBytes: 250 * 1024 * 1024,
  allowedMediaMimeTypes: DEFAULT_ALLOWED_MEDIA_MIME_TYPES,
};

type PartialDocxUnzipLimits = Partial<
  Omit<DocxUnzipLimits, "allowedMediaMimeTypes">
> & {
  allowedMediaMimeTypes?: Iterable<string>;
};

type ZipEntryWithMetadata = {
  _data?: {
    uncompressedSize?: number;
    compressedSize?: number;
  };
};

/**
 * Raw extracted content from a DOCX file
 */
export type RawDocxContent = {
  // Main document
  documentXml: string | null;

  // Styles and formatting
  stylesXml: string | null;
  themeXml: string | null;
  numberingXml: string | null;
  fontTableXml: string | null;
  settingsXml: string | null;
  webSettingsXml: string | null;

  // Headers and footers (keyed by filename, e.g., "header1.xml")
  headers: Map<string, string>;
  footers: Map<string, string>;

  // Footnotes and endnotes
  footnotesXml: string | null;
  endnotesXml: string | null;

  // Comments
  commentsXml: string | null;
  // commentsExtensible.xml (w16cex, Word 2016+) carries UTC timestamps via
  // `w16cex:dateUtc`. Different file with a different schema from
  // commentsExtended.xml, even though the names look similar.
  commentsExtensibleXml: string | null;
  // commentsExtended.xml (w15, Word 2013+) carries reply-thread parent
  // links via `w15:paraIdParent` and the resolved/done state via
  // `w15:done`. Needed to reconstruct comment reply threads on import.
  commentsExtendedXml: string | null;

  // Relationships
  documentRels: string | null;
  packageRels: string | null;

  // Content types
  contentTypesXml: string | null;

  // Document properties
  corePropsXml: string | null;
  appPropsXml: string | null;
  customPropsXml: string | null;

  // Media files (images, etc.) - keyed by path, e.g., "word/media/image1.png"
  media: Map<string, ArrayBuffer>;

  // Embedded fonts - keyed by path
  fonts: Map<string, ArrayBuffer>;

  // All XML files (for any we might have missed)
  allXml: Map<string, string>;

  // Original ZIP for round-trip preservation
  originalZip: JSZip;

  // Original buffer for round-trip
  originalBuffer: ArrayBuffer;
};

/**
 * Extract all content from a DOCX file
 *
 * @param buffer - DOCX file as ArrayBuffer
 * @returns Promise resolving to extracted content
 */
export async function unzipDocx(
  buffer: ArrayBuffer,
  options: PartialDocxUnzipLimits = {},
): Promise<RawDocxContent> {
  const limits = createUnzipLimits(options);
  if (buffer.byteLength > limits.maxInputBytes) {
    throw new DocxSecurityError("DOCX file exceeds the maximum allowed size");
  }

  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.entries(zip.files).filter(([, file]) => !file.dir);

  if (entries.length > limits.maxFiles) {
    throw new DocxSecurityError("DOCX file contains too many entries");
  }

  const content: RawDocxContent = {
    documentXml: null,
    stylesXml: null,
    themeXml: null,
    numberingXml: null,
    fontTableXml: null,
    settingsXml: null,
    webSettingsXml: null,
    headers: new Map(),
    footers: new Map(),
    footnotesXml: null,
    endnotesXml: null,
    commentsXml: null,
    commentsExtensibleXml: null,
    commentsExtendedXml: null,
    documentRels: null,
    packageRels: null,
    contentTypesXml: null,
    corePropsXml: null,
    appPropsXml: null,
    customPropsXml: null,
    media: new Map(),
    fonts: new Map(),
    allXml: new Map(),
    originalZip: zip,
    originalBuffer: buffer,
  };

  let totalUncompressedBytes = 0;

  // Process each file in the ZIP
  for (const [path, file] of entries) {
    if (!isSafeDocxPath(path)) {
      throw new DocxSecurityError("DOCX file contains an unsafe entry path");
    }

    if (!isPreservableDocxEntry(path)) {
      continue;
    }

    const lowerPath = path.toLowerCase();
    const declaredSize = getEntryUncompressedSize(file);

    if (declaredSize !== null) {
      totalUncompressedBytes += declaredSize;
      if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
        throw new DocxSecurityError(
          "DOCX file expands beyond the maximum allowed size",
        );
      }
    }

    // Determine file type and extract
    if (lowerPath.endsWith(".xml") || lowerPath.endsWith(".rels")) {
      assertEntrySize(path, declaredSize, limits.maxXmlBytes);
      const xmlContent = await file.async("text");
      assertExtractedSize(path, xmlContent.length, limits.maxXmlBytes);
      content.allXml.set(path, xmlContent);

      // Categorize known XML files
      if (lowerPath === "word/document.xml") {
        content.documentXml = xmlContent;
      } else if (lowerPath === "word/styles.xml") {
        content.stylesXml = xmlContent;
      } else if (lowerPath === "word/theme/theme1.xml") {
        content.themeXml = xmlContent;
      } else if (lowerPath === "word/numbering.xml") {
        content.numberingXml = xmlContent;
      } else if (lowerPath === "word/fonttable.xml") {
        content.fontTableXml = xmlContent;
      } else if (lowerPath === "word/settings.xml") {
        content.settingsXml = xmlContent;
      } else if (lowerPath === "word/websettings.xml") {
        content.webSettingsXml = xmlContent;
      } else if (lowerPath === "word/footnotes.xml") {
        content.footnotesXml = xmlContent;
      } else if (lowerPath === "word/endnotes.xml") {
        content.endnotesXml = xmlContent;
      } else if (lowerPath === "word/comments.xml") {
        content.commentsXml = xmlContent;
      } else if (lowerPath === "word/commentsextensible.xml") {
        content.commentsExtensibleXml = xmlContent;
      } else if (lowerPath === "word/commentsextended.xml") {
        content.commentsExtendedXml = xmlContent;
      } else if (lowerPath === "word/_rels/document.xml.rels") {
        content.documentRels = xmlContent;
      } else if (lowerPath === "_rels/.rels") {
        content.packageRels = xmlContent;
      } else if (lowerPath === "[content_types].xml") {
        content.contentTypesXml = xmlContent;
      } else if (lowerPath === "docprops/core.xml") {
        content.corePropsXml = xmlContent;
      } else if (lowerPath === "docprops/app.xml") {
        content.appPropsXml = xmlContent;
      } else if (lowerPath === "docprops/custom.xml") {
        content.customPropsXml = xmlContent;
      } else if (/^word\/header\d+\.xml$/.test(lowerPath)) {
        const filename = path.split("/").pop() || path;
        content.headers.set(filename, xmlContent);
      } else if (/^word\/footer\d+\.xml$/.test(lowerPath)) {
        const filename = path.split("/").pop() || path;
        content.footers.set(filename, xmlContent);
      }
    } else if (lowerPath.startsWith("word/media/")) {
      // Media files (images, etc.)
      const mimeType = getMediaMimeType(path);
      assertEntrySize(path, declaredSize, limits.maxMediaBytes);
      if (!limits.allowedMediaMimeTypes.has(mimeType)) {
        continue;
      }
      const binaryContent = await file.async("arraybuffer");
      assertExtractedSize(path, binaryContent.byteLength, limits.maxMediaBytes);
      if (!isMediaContentAllowed(binaryContent, mimeType)) {
        continue;
      }
      content.media.set(path, binaryContent);
    } else if (lowerPath.startsWith("word/fonts/")) {
      // Embedded fonts
      assertEntrySize(path, declaredSize, limits.maxFontBytes);
      const binaryContent = await file.async("arraybuffer");
      assertExtractedSize(path, binaryContent.byteLength, limits.maxFontBytes);
      content.fonts.set(path, binaryContent);
    }
  }

  return content;
}

function createUnzipLimits(options: PartialDocxUnzipLimits): DocxUnzipLimits {
  return {
    ...DEFAULT_UNZIP_LIMITS,
    ...options,
    allowedMediaMimeTypes: options.allowedMediaMimeTypes
      ? new Set(options.allowedMediaMimeTypes)
      : DEFAULT_UNZIP_LIMITS.allowedMediaMimeTypes,
  };
}

function isSafeDocxPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\")) {
    return false;
  }
  return !path.split("/").some((part) => part === "..");
}

export function isPreservableDocxEntry(path: string): boolean {
  if (!isSafeDocxPath(path)) {
    return false;
  }

  const lowerPath = path.toLowerCase();
  if (lowerPath.startsWith("word/media/")) {
    return PRESERVABLE_MEDIA_MIME_TYPES.has(getMediaMimeType(path));
  }

  if (lowerPath.startsWith("word/fonts/")) {
    return true;
  }

  if (!(lowerPath.endsWith(".xml") || lowerPath.endsWith(".rels"))) {
    return false;
  }

  return (
    lowerPath === "[content_types].xml" ||
    lowerPath.startsWith("_rels/") ||
    lowerPath.startsWith("docprops/") ||
    lowerPath.startsWith("word/") ||
    lowerPath.startsWith("customxml/")
  );
}

function getEntryUncompressedSize(file: JSZip.JSZipObject): number | null {
  const metadata = (file as JSZip.JSZipObject & ZipEntryWithMetadata)._data;
  return typeof metadata?.uncompressedSize === "number"
    ? metadata.uncompressedSize
    : null;
}

function assertEntrySize(
  path: string,
  declaredSize: number | null,
  maxBytes: number,
): void {
  if (declaredSize !== null && declaredSize > maxBytes) {
    throw new DocxSecurityError(`DOCX entry exceeds maximum size: ${path}`);
  }
}

function assertExtractedSize(
  path: string,
  byteLength: number,
  maxBytes: number,
): void {
  if (byteLength > maxBytes) {
    throw new DocxSecurityError(`DOCX entry exceeds maximum size: ${path}`);
  }
}

function isMediaContentAllowed(data: ArrayBuffer, mimeType: string): boolean {
  const bytes = new Uint8Array(data);
  switch (mimeType) {
    case "image/png":
      return (
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47
      );
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8;
    case "image/gif":
      return (
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x38
      );
    case "image/bmp":
      return bytes[0] === 0x42 && bytes[1] === 0x4d;
    case "image/webp":
      return (
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );
    case "image/tiff":
      return (
        (bytes[0] === 0x49 && bytes[1] === 0x49) ||
        (bytes[0] === 0x4d && bytes[1] === 0x4d)
      );
    default:
      return false;
  }
}

/**
 * Get a list of all files in the DOCX
 *
 * @param content - Extracted DOCX content
 * @returns Array of file paths
 */
export function getFileList(content: RawDocxContent): string[] {
  const files: string[] = [];

  for (const path of Object.keys(content.originalZip.files)) {
    if (!content.originalZip.files[path]?.dir && isPreservableDocxEntry(path)) {
      files.push(path);
    }
  }

  return files.toSorted();
}

/**
 * Get the MIME type for a media file based on extension
 *
 * @param path - File path
 * @returns MIME type string
 */
export function getMediaMimeType(path: string): string {
  const ext = path.toLowerCase().split(".").pop();

  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "tif":
    case "tiff":
      return "image/tiff";
    case "wmf":
      return "image/x-wmf";
    case "emf":
      return "image/x-emf";
    case "svg":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

/**
 * Convert media file to data URL
 *
 * @param data - Binary data
 * @param mimeType - MIME type
 * @returns Data URL string
 */
export function mediaToDataUrl(data: ArrayBuffer, mimeType: string): string {
  const bytes = new Uint8Array(data);
  const chunks: string[] = [];
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    chunks.push(String.fromCodePoint(...chunk));
  }
  const base64 = btoa(chunks.join(""));
  return `data:${mimeType};base64,${base64}`;
}

/**
 * Extract a specific file from the original ZIP
 *
 * @param content - Extracted DOCX content
 * @param path - File path within the ZIP
 * @returns File content as string or ArrayBuffer, or null if not found
 */
export function extractFile(
  content: RawDocxContent,
  path: string,
): Promise<string | ArrayBuffer | null> {
  const file = content.originalZip.file(path);
  if (!file || !isPreservableDocxEntry(path)) {
    return Promise.resolve(null);
  }

  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith(".xml") || lowerPath.endsWith(".rels")) {
    return file.async("text");
  }
  return file.async("arraybuffer");
}

/**
 * Check if a file exists in the DOCX
 *
 * @param content - Extracted DOCX content
 * @param path - File path to check
 * @returns true if file exists
 */
export function hasFile(content: RawDocxContent, path: string): boolean {
  return content.originalZip.file(path) !== null;
}

/**
 * Get summary of DOCX content
 *
 * @param content - Extracted DOCX content
 * @returns Object with file counts and presence flags
 */
export function getContentSummary(content: RawDocxContent): {
  hasDocument: boolean;
  hasStyles: boolean;
  hasTheme: boolean;
  hasNumbering: boolean;
  hasFontTable: boolean;
  hasFootnotes: boolean;
  hasEndnotes: boolean;
  hasComments: boolean;
  headerCount: number;
  footerCount: number;
  mediaCount: number;
  fontCount: number;
  totalFiles: number;
} {
  return {
    hasDocument: content.documentXml !== null,
    hasStyles: content.stylesXml !== null,
    hasTheme: content.themeXml !== null,
    hasNumbering: content.numberingXml !== null,
    hasFontTable: content.fontTableXml !== null,
    hasFootnotes: content.footnotesXml !== null,
    hasEndnotes: content.endnotesXml !== null,
    hasComments: content.commentsXml !== null,
    headerCount: content.headers.size,
    footerCount: content.footers.size,
    mediaCount: content.media.size,
    fontCount: content.fonts.size,
    totalFiles: Object.keys(content.originalZip.files).filter(
      (p) => !content.originalZip.files[p]?.dir,
    ).length,
  };
}
