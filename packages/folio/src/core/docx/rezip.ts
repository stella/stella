/**
 * DOCX Repacker - Repack modified document into valid DOCX
 *
 * Takes a Document with modified content and creates a new DOCX file
 * by updating document.xml while preserving all other files from
 * the original ZIP archive.
 *
 * This ensures round-trip fidelity:
 * - styles.xml, theme1.xml, fontTable.xml remain untouched
 * - Media files preserved
 * - Relationships preserved
 * - Only document.xml is updated with new content
 *
 * OOXML Package Structure:
 * - [Content_Types].xml - Content type declarations
 * - _rels/.rels - Package relationships
 * - word/document.xml - Main document (modified)
 * - word/styles.xml - Styles (preserved)
 * - word/theme/theme1.xml - Theme (preserved)
 * - word/numbering.xml - Numbering (preserved)
 * - word/fontTable.xml - Font table (preserved)
 * - word/settings.xml - Settings (preserved)
 * - word/header*.xml - Headers (preserved)
 * - word/footer*.xml - Footers (preserved)
 * - word/footnotes.xml - Footnotes (preserved)
 * - word/endnotes.xml - Endnotes (preserved)
 * - word/media/* - Media files (preserved)
 * - word/_rels/document.xml.rels - Document relationships (preserved)
 * - docProps/* - Document properties (preserved)
 */

import { panic } from "better-result";
import JSZip from "jszip";

import type {
  BlockContent,
  HeaderFooter,
  Image,
  Hyperlink,
} from "../types/content";
import type { Document, Watermark } from "../types/document";
import { assertValidFolioDocumentModel } from "./modelValidation";
import {
  parseRelationships,
  RELATIONSHIP_TYPES,
  resolveRelativePath,
} from "./relsParser";
import { serializeComments } from "./serializer/commentSerializer";
import { serializeDocument } from "./serializer/documentSerializer";
import { serializeHeaderFooter } from "./serializer/headerFooterSerializer";
import { escapeXml } from "./serializer/xmlUtils";
import { isPreservableDocxEntry } from "./unzip";
import type { RawDocxContent } from "./unzip";

export class DocxPackageFidelityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocxPackageFidelityError";
  }
}

/**
 * Find the highest rId number in a relationships XML string.
 */
export function findMaxRId(relsXml: string): number {
  let maxId = 0;
  for (const match of relsXml.matchAll(/Id="rId(\d+)"/gu)) {
    // SAFETY: capture group [1] always present when regex matches
    const id = Number.parseInt(match[1]!, 10);
    if (id > maxId) {
      maxId = id;
    }
  }
  return maxId;
}

const countDocumentSections = (xml: string): number =>
  Array.from(xml.matchAll(/<w:sectPr\b/gu)).length;

type HeaderFooterReference = {
  element: "headerReference" | "footerReference";
  type: string;
  rId: string;
};

const extractHeaderFooterReferences = (
  xml: string,
): HeaderFooterReference[] => {
  const references: HeaderFooterReference[] = [];
  const pattern = /<w:(headerReference|footerReference)\b[^>]*>/gu;
  for (const match of xml.matchAll(pattern)) {
    const tag = match[0];
    const type = /\bw:type="([^"]+)"/u.exec(tag)?.at(1) ?? "default";
    const rId = /\br:id="([^"]+)"/u.exec(tag)?.at(1);
    const element = match[1];
    if (
      !rId ||
      (element !== "headerReference" && element !== "footerReference")
    ) {
      continue;
    }
    references.push({ element, type, rId });
  }
  return references;
};

const hasParsedHeaderFooterPart = (
  doc: Document,
  ref: HeaderFooterReference,
): boolean => {
  const map =
    ref.element === "headerReference"
      ? doc.package.headers
      : doc.package.footers;
  return map?.has(ref.rId) ?? false;
};

function assertDocumentPackageFidelity(
  originalDocumentXml: string,
  serializedDocumentXml: string,
  doc: Document,
): void {
  const originalSectionCount = countDocumentSections(originalDocumentXml);
  const serializedSectionCount = countDocumentSections(serializedDocumentXml);
  if (serializedSectionCount < originalSectionCount) {
    throw new DocxPackageFidelityError(
      "Full DOCX repack would drop section properties. Use selective patching instead.",
    );
  }

  const serializedRefs = new Set(
    extractHeaderFooterReferences(serializedDocumentXml).map(
      (ref) => `${ref.element}:${ref.type}:${ref.rId}`,
    ),
  );
  const missingRefs = extractHeaderFooterReferences(originalDocumentXml).filter(
    (ref) =>
      hasParsedHeaderFooterPart(doc, ref) &&
      !serializedRefs.has(`${ref.element}:${ref.type}:${ref.rId}`),
  );
  if (missingRefs.length > 0) {
    throw new DocxPackageFidelityError(
      "Full DOCX repack would drop header/footer references. Use selective patching instead.",
    );
  }
}

// ============================================================================
// COMMENTS SERIALIZATION
// ============================================================================

async function serializeCommentsToZip(
  doc: Document,
  zip: JSZip,
  compressionLevel: number,
): Promise<void> {
  const comments = doc.package.document.comments ?? [];
  // Whether the source DOCX already had a `word/comments.xml`. If it did
  // and we now have zero comments (e.g., the user deleted the only
  // anchored thread), we MUST overwrite with an empty <w:comments/>
  // — otherwise the previous file is copied through the rezip baseline
  // and the saved DOCX still surfaces the now-phantom threads.
  const hadCommentsFile = zip.file("word/comments.xml") !== null;
  if (comments.length === 0 && !hadCommentsFile) {
    return;
  }

  const commentsXml = serializeComments(comments);
  zip.file("word/comments.xml", commentsXml, {
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });

  await Promise.all([
    ensureCommentsContentType(zip, compressionLevel),
    ensureCommentsRelationship(zip, compressionLevel),
  ]);
}

// ============================================================================
// NEW IMAGE HANDLING
// ============================================================================

type DocxPart = {
  relsPath: string;
  blocks: BlockContent[];
};

const EMPTY_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

function headerFooterFilename(target: string): string {
  return target.startsWith("/") ? target.slice(1) : `word/${target}`;
}

/**
 * The relationships part for a header/footer. A part at `<dir>/<name>` keeps its
 * rels at `<dir>/_rels/<name>.rels` — e.g. `word/headers/header1.xml` ->
 * `word/headers/_rels/header1.xml.rels`, not a flattened `word/_rels/...`.
 */
function headerFooterRelsPath(target: string): string {
  const partPath = headerFooterFilename(target);
  const lastSlash = partPath.lastIndexOf("/");
  const directory = lastSlash === -1 ? "" : partPath.slice(0, lastSlash);
  const name = lastSlash === -1 ? partPath : partPath.slice(lastSlash + 1);
  return `${directory ? `${directory}/` : ""}_rels/${name}.rels`;
}

/**
 * Express an absolute package path as a relationship target relative to the
 * part at `partPath`. e.g. media `word/media/image1.png` for a part at
 * `word/headers/header2.xml` -> `../media/image1.png` (and `media/image1.png`
 * for a part at the `word/` root). The inverse of `resolveRelativePath`.
 */
function relativeTargetForPart(
  partPath: string,
  absoluteTarget: string,
): string {
  const lastSlash = partPath.lastIndexOf("/");
  const fromDir =
    lastSlash === -1 ? [] : partPath.slice(0, lastSlash).split("/");
  const to = absoluteTarget.split("/");
  let shared = 0;
  while (
    shared < fromDir.length &&
    shared < to.length - 1 &&
    fromDir[shared] === to[shared]
  ) {
    shared += 1;
  }
  return `${"../".repeat(fromDir.length - shared)}${to.slice(shared).join("/")}`;
}

function collectImageParts(doc: Document): DocxPart[] {
  const parts: DocxPart[] = [
    {
      relsPath: "word/_rels/document.xml.rels",
      blocks: doc.package.document.content,
    },
  ];
  const rels = doc.package.relationships;
  if (!rels) {
    return parts;
  }

  const addHeaderFooterParts = (
    map: Map<string, HeaderFooter> | undefined,
    type: string,
  ) => {
    if (!map) {
      return;
    }
    for (const [rId, headerFooter] of map.entries()) {
      const rel = rels.get(rId);
      if (!rel || rel.type !== type || !rel.target) {
        continue;
      }
      parts.push({
        relsPath: headerFooterRelsPath(rel.target),
        blocks: headerFooter.content,
      });
    }
  };

  addHeaderFooterParts(doc.package.headers, RELATIONSHIP_TYPES.header);
  addHeaderFooterParts(doc.package.footers, RELATIONSHIP_TYPES.footer);

  return parts;
}

async function readRelsOrStub(zip: JSZip, relsPath: string): Promise<string> {
  const file = zip.file(relsPath);
  const xml = file ? await file.async("text") : EMPTY_RELS_XML;
  return xml.replace(
    /<Relationships([^>]*)\/>/u,
    "<Relationships$1></Relationships>",
  );
}

function findMaxImageNum(zip: JSZip): number {
  let maxImageNum = 0;
  zip.forEach((relativePath) => {
    const m = /^word\/media\/image(\d+)\./u.exec(relativePath);
    if (m) {
      // SAFETY: capture group [1] always present when regex matches
      const num = Number.parseInt(m[1]!, 10);
      if (num > maxImageNum) {
        maxImageNum = num;
      }
    }
  });
  return maxImageNum;
}

async function registerImageExtensions(
  zip: JSZip,
  extensions: Set<string>,
  compressionLevel: number,
): Promise<void> {
  if (extensions.size === 0) {
    return;
  }
  const ctFile = zip.file("[Content_Types].xml");
  if (!ctFile) {
    return;
  }

  let ctXml = await ctFile.async("text");
  let changed = false;
  for (const ext of extensions) {
    if (ctXml.includes(`Extension="${ext}"`)) {
      continue;
    }
    const contentType = getContentTypeForExtension(ext, "");
    ctXml = ctXml.replace(
      "</Types>",
      `<Default Extension="${ext}" ContentType="${contentType}"/></Types>`,
    );
    changed = true;
  }

  if (!changed) {
    return;
  }
  zip.file("[Content_Types].xml", ctXml, {
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });
}

/**
 * Collect all newly inserted images with data-URL src from the document content.
 * Existing DOCX images may also have a resolved data URL for preview; those must
 * continue to reference their original media part. Editor-created images use a
 * synthetic rId until they are assigned a real DOCX relationship here.
 */
const SYNTHETIC_IMAGE_RID_PREFIX = "rId_img_";

const isNewDataUrlImage = (image: Image) =>
  image.src?.startsWith("data:") &&
  (!image.rId || image.rId.startsWith(SYNTHETIC_IMAGE_RID_PREFIX));

function collectNewImages(blocks: BlockContent[]): Image[] {
  const images: Image[] = [];

  const collectFromRun = (run: {
    content: { type: string; image?: Image }[];
  }): void => {
    for (const c of run.content) {
      if (c.type === "drawing" && c.image && isNewDataUrlImage(c.image)) {
        images.push(c.image);
      }
    }
  };

  for (const block of blocks) {
    if (block.type === "paragraph") {
      for (const item of block.content) {
        if (item.type === "run") {
          collectFromRun(item);
        } else if (
          // A picture inserted/deleted/moved under track changes lives inside
          // an ins/del/moveFrom/moveTo wrapper. Descend so its media part
          // still gets written. eigenpal #641.
          item.type === "insertion" ||
          item.type === "deletion" ||
          item.type === "moveFrom" ||
          item.type === "moveTo"
        ) {
          for (const sub of item.content) {
            if (sub.type === "run") {
              collectFromRun(sub);
            }
          }
        }
      }
    } else if (block.type === "table") {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          images.push(...collectNewImages(cell.content));
        }
      }
    }
  }

  return images;
}

/** Map MIME type to file extension (inverse of getContentTypeForExtension) */
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/**
 * Decode a data URL to binary ArrayBuffer and file extension.
 */
function decodeDataUrl(dataUrl: string): {
  data: ArrayBuffer;
  extension: string;
} {
  const match = /^data:([^;]+);base64,(.+)$/u.exec(dataUrl);
  if (!match) {
    panic("Invalid data URL");
  }

  // SAFETY: capture groups [1] and [2] always present when regex matches
  const binary = atob(match[2]!);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.codePointAt(i) ?? 0;
  }

  return { data: bytes.buffer, extension: MIME_TO_EXT[match[1]!] ?? "png" };
}

/**
 * Process newly inserted images: add binary data to ZIP, create relationships,
 * update content types, and rewrite rIds in the document model so the serializer
 * outputs correct references.
 *
 * Mutates the images' rId fields in-place.
 */
async function processNewImages(
  parts: DocxPart[],
  zip: JSZip,
  compressionLevel: number,
): Promise<void> {
  let maxImageNum = findMaxImageNum(zip);
  const extensionsAdded = new Set<string>();

  for (const { relsPath, blocks } of parts) {
    const newImages = collectNewImages(blocks);
    if (newImages.length === 0) {
      continue;
    }

    const relsXml = await readRelsOrStub(zip, relsPath);
    let maxId = findMaxRId(relsXml);
    const relEntries: string[] = [];

    for (const image of newImages) {
      if (!image.src) {
        continue;
      }
      const { data, extension } = decodeDataUrl(image.src);

      maxImageNum++;
      maxId++;
      const mediaFilename = `image${maxImageNum}.${extension}`;
      const mediaPath = `word/media/${mediaFilename}`;
      const newRId = `rId${maxId}`;

      // Add binary to ZIP
      zip.file(mediaPath, data, {
        compression: "DEFLATE",
        compressionOptions: { level: compressionLevel },
      });

      // Build relationship entry
      relEntries.push(
        `<Relationship Id="${newRId}" Type="${RELATIONSHIP_TYPES.image}" Target="media/${mediaFilename}"/>`,
      );

      extensionsAdded.add(extension);

      // Rewrite the image's rId so the serializer outputs the correct reference
      image.rId = newRId;
    }

    if (relEntries.length > 0) {
      const updatedRelsXml = relsXml.replace(
        "</Relationships>",
        `${relEntries.join("")}</Relationships>`,
      );
      zip.file(relsPath, updatedRelsXml, {
        compression: "DEFLATE",
        compressionOptions: { level: compressionLevel },
      });
    }
  }

  await registerImageExtensions(zip, extensionsAdded, compressionLevel);
}

// ============================================================================
// NEW HYPERLINK HANDLING
// ============================================================================

/**
 * Collect all hyperlinks that have an href but no rId from block content.
 * These are newly created hyperlinks that need relationship entries.
 */
function collectHyperlinksWithoutRId(blocks: BlockContent[]): Hyperlink[] {
  const hyperlinks: Hyperlink[] = [];

  for (const block of blocks) {
    if (block.type === "paragraph") {
      for (const item of block.content) {
        if (
          item.type === "hyperlink" &&
          item.href &&
          !item.rId &&
          !item.anchor
        ) {
          hyperlinks.push(item);
        }
      }
    } else if (block.type === "table") {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          hyperlinks.push(...collectHyperlinksWithoutRId(cell.content));
        }
      }
    }
  }

  return hyperlinks;
}

/**
 * Process newly created hyperlinks: assign rIds and add relationship entries.
 * Mutates the hyperlinks' rId fields in-place.
 */
async function processNewHyperlinks(
  newHyperlinks: Hyperlink[],
  zip: JSZip,
  compressionLevel: number,
): Promise<void> {
  if (newHyperlinks.length === 0) {
    return;
  }

  const relsPath = "word/_rels/document.xml.rels";
  const relsFile = zip.file(relsPath);
  if (!relsFile) {
    return;
  }
  let relsXml = await relsFile.async("text");

  let maxId = findMaxRId(relsXml);
  const relEntries: string[] = [];

  for (const hyperlink of newHyperlinks) {
    maxId++;
    const newRId = `rId${maxId}`;

    if (!hyperlink.href) {
      continue;
    }
    relEntries.push(
      `<Relationship Id="${newRId}" Type="${RELATIONSHIP_TYPES.hyperlink}" Target="${escapeXml(hyperlink.href)}" TargetMode="External"/>`,
    );

    // Rewrite the hyperlink's rId so the serializer outputs the correct reference
    hyperlink.rId = newRId;
  }

  if (relEntries.length > 0) {
    relsXml = relsXml.replace(
      "</Relationships>",
      `${relEntries.join("")}</Relationships>`,
    );
    zip.file(relsPath, relsXml, {
      compression: "DEFLATE",
      compressionOptions: { level: compressionLevel },
    });
  }
}

// ============================================================================
// MAIN REPACKER
// ============================================================================

/**
 * Options for repacking DOCX
 */
export type RepackOptions = {
  /** Compression level (0-9, default: 6) */
  compressionLevel?: number;
  /** Whether to update modification date in docProps/core.xml */
  updateModifiedDate?: boolean;
  /** Custom modifier name for lastModifiedBy */
  modifiedBy?: string;
};

/**
 * Repack a Document into a valid DOCX file
 *
 * @param doc - Document with modified content
 * @param options - Optional repack options
 * @returns Promise resolving to DOCX as ArrayBuffer
 * @throws Error if document has no original buffer for round-trip
 */
export async function repackDocx(
  doc: Document,
  options: RepackOptions = {},
): Promise<ArrayBuffer> {
  // Validate we have an original buffer to base on
  if (!doc.originalBuffer) {
    panic(
      "Cannot repack document: no original buffer for round-trip. " +
        "Use createDocx() for new documents.",
    );
  }

  const {
    compressionLevel = 6,
    updateModifiedDate = true,
    modifiedBy,
  } = options;
  const exportDocument = doc;

  // Load the original ZIP
  const originalZip = await JSZip.loadAsync(doc.originalBuffer);

  // Create a new ZIP with all original files
  const newZip = new JSZip();

  // Copy all files from original ZIP
  for (const [path, file] of Object.entries(originalZip.files)) {
    // Skip directories
    if (file.dir) {
      newZip.folder(path.replace(/\/$/u, ""));
      continue;
    }

    if (!isPreservableDocxEntry(path)) {
      continue;
    }

    // Get original file content
    const content = await file.async("arraybuffer");

    // Add to new ZIP (we'll update specific files below)
    newZip.file(path, content, {
      compression: "DEFLATE",
      compressionOptions: { level: compressionLevel },
    });
  }

  // Promote in-memory header/footer parts to real parts/relationships first, so
  // collectImageParts sees them and processNewImages can write image relations
  // into a newly created header/footer's own rels.
  await materializeNewHeaderFooterParts(
    exportDocument,
    newZip,
    compressionLevel,
  );

  // Process newly inserted images (data URLs → binary media files + relationships).
  // This mutates image rIds in-place so the serializer outputs correct references.
  await processNewImages(
    collectImageParts(exportDocument),
    newZip,
    compressionLevel,
  );

  // Process newly created hyperlinks (assign rIds + add relationship entries).
  // This mutates hyperlink rIds in-place so the serializer outputs correct references.
  const newHyperlinks = collectHyperlinksWithoutRId(
    exportDocument.package.document.content,
  );
  await processNewHyperlinks(newHyperlinks, newZip, compressionLevel);

  assertValidFolioDocumentModel(
    exportDocument,
    "Cannot repack invalid DOCX document model",
  );

  // Serialize and update document.xml (after image/hyperlink rIds have been rewritten)
  const documentXml = serializeDocument(exportDocument);
  const originalDocumentXml = await originalZip
    .file("word/document.xml")
    ?.async("text");
  if (originalDocumentXml) {
    assertDocumentPackageFidelity(
      originalDocumentXml,
      documentXml,
      exportDocument,
    );
  }
  newZip.file("word/document.xml", documentXml, {
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });

  // Rebind picture-watermark image rIds so each header references the image in
  // its own rels (materialization, run before image processing above, gave
  // coverage-created header parts a relationship target to anchor against).
  await rebindWatermarkRelIds(exportDocument, newZip, compressionLevel);

  // Serialize and update modified headers/footers
  serializeHeadersFootersToZip(exportDocument, newZip, compressionLevel);

  // Serialize comments
  await serializeCommentsToZip(exportDocument, newZip, compressionLevel);

  // Optionally update modification date in docProps/core.xml
  if (updateModifiedDate) {
    const corePropsPath = "docProps/core.xml";
    const corePropsFile = originalZip.file(corePropsPath);

    if (corePropsFile) {
      const originalCoreProps = await corePropsFile.async("text");
      const updatedCoreProps = updateCoreProperties(originalCoreProps, {
        updateModifiedDate,
        ...(modifiedBy !== undefined ? { modifiedBy } : {}),
      });

      newZip.file(corePropsPath, updatedCoreProps, {
        compression: "DEFLATE",
        compressionOptions: { level: compressionLevel },
      });
    }
  }

  // Generate the new DOCX file
  const arrayBuffer = await newZip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });

  return arrayBuffer;
}

/**
 * Repack a Document using raw content for more control
 *
 * @param doc - Document with modified content
 * @param rawContent - Original raw content from unzipDocx
 * @param options - Optional repack options
 * @returns Promise resolving to DOCX as ArrayBuffer
 */
export async function repackDocxFromRaw(
  doc: Document,
  rawContent: RawDocxContent,
  options: RepackOptions = {},
): Promise<ArrayBuffer> {
  const {
    compressionLevel = 6,
    updateModifiedDate = true,
    modifiedBy,
  } = options;
  const exportDocument = doc;

  // Create a new ZIP with all original files
  const newZip = new JSZip();

  // Copy all files from original ZIP
  for (const [path, file] of Object.entries(rawContent.originalZip.files)) {
    // Skip directories
    if (file.dir) {
      newZip.folder(path.replace(/\/$/u, ""));
      continue;
    }

    if (!isPreservableDocxEntry(path)) {
      continue;
    }

    // Get original file content
    const content = await file.async("arraybuffer");

    // Add to new ZIP
    newZip.file(path, content, {
      compression: "DEFLATE",
      compressionOptions: { level: compressionLevel },
    });
  }

  // Promote in-memory header/footer parts to real parts/relationships first, so
  // collectImageParts sees them and processNewImages can write image relations
  // into a newly created header/footer's own rels.
  await materializeNewHeaderFooterParts(
    exportDocument,
    newZip,
    compressionLevel,
  );

  await processNewImages(
    collectImageParts(exportDocument),
    newZip,
    compressionLevel,
  );

  const newHyperlinks = collectHyperlinksWithoutRId(
    exportDocument.package.document.content,
  );
  await processNewHyperlinks(newHyperlinks, newZip, compressionLevel);

  assertValidFolioDocumentModel(
    exportDocument,
    "Cannot repack invalid DOCX document model",
  );

  const documentXml = serializeDocument(exportDocument);
  if (rawContent.documentXml) {
    assertDocumentPackageFidelity(
      rawContent.documentXml,
      documentXml,
      exportDocument,
    );
  }
  newZip.file("word/document.xml", documentXml, {
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });

  // Rebind picture-watermark image rIds so each header references the image in
  // its own rels (materialization, run before image processing above, gave
  // coverage-created header parts a relationship target to anchor against).
  await rebindWatermarkRelIds(exportDocument, newZip, compressionLevel);

  // Serialize and update modified headers/footers
  serializeHeadersFootersToZip(exportDocument, newZip, compressionLevel);

  // Serialize comments
  await serializeCommentsToZip(exportDocument, newZip, compressionLevel);

  // Optionally update core properties
  if (updateModifiedDate && rawContent.corePropsXml) {
    const updatedCoreProps = updateCoreProperties(rawContent.corePropsXml, {
      updateModifiedDate,
      ...(modifiedBy !== undefined ? { modifiedBy } : {}),
    });

    newZip.file("docProps/core.xml", updatedCoreProps, {
      compression: "DEFLATE",
      compressionOptions: { level: compressionLevel },
    });
  }

  // Generate the new DOCX file
  const arrayBuffer = await newZip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });

  return arrayBuffer;
}

// ============================================================================
// COMMENT PACKAGING HELPERS
// ============================================================================

export const COMMENTS_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml";

/**
 * Ensure [Content_Types].xml contains an Override for word/comments.xml.
 * If the document already had comments, this is a no-op.
 */
async function ensureCommentsContentType(
  zip: JSZip,
  compressionLevel: number,
): Promise<void> {
  const ctFile = zip.file("[Content_Types].xml");
  if (!ctFile) {
    return;
  }

  let ctXml = await ctFile.async("text");
  if (ctXml.includes("/word/comments.xml")) {
    return;
  }

  // Insert before closing </Types>
  ctXml = ctXml.replace(
    "</Types>",
    `<Override PartName="/word/comments.xml" ContentType="${COMMENTS_CONTENT_TYPE}"/></Types>`,
  );
  zip.file("[Content_Types].xml", ctXml, {
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });
}

/**
 * Ensure word/_rels/document.xml.rels contains a Relationship for comments.xml.
 * If the document already had comments, this is a no-op.
 */
async function ensureCommentsRelationship(
  zip: JSZip,
  compressionLevel: number,
): Promise<void> {
  const relsPath = "word/_rels/document.xml.rels";
  const relsFile = zip.file(relsPath);
  if (!relsFile) {
    return;
  }

  let relsXml = await relsFile.async("text");
  if (relsXml.includes("comments.xml")) {
    return;
  }

  // Generate a unique rId
  const newRId = `rId${findMaxRId(relsXml) + 1}`;

  relsXml = relsXml.replace(
    "</Relationships>",
    `<Relationship Id="${newRId}" Type="${RELATIONSHIP_TYPES.comments}" Target="comments.xml"/></Relationships>`,
  );
  zip.file(relsPath, relsXml, {
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });
}

// ============================================================================
// SELECTIVE UPDATES
// ============================================================================

/**
 * Update only document.xml in a DOCX buffer (minimal changes)
 *
 * @param originalBuffer - Original DOCX as ArrayBuffer
 * @param newDocumentXml - New document.xml content
 * @param options - Optional repack options
 * @returns Promise resolving to DOCX as ArrayBuffer
 */
export async function updateDocumentXml(
  originalBuffer: ArrayBuffer,
  newDocumentXml: string,
  options: RepackOptions = {},
): Promise<ArrayBuffer> {
  const { compressionLevel = 6 } = options;

  // Load original ZIP
  const zip = await JSZip.loadAsync(originalBuffer);

  // Update document.xml
  zip.file("word/document.xml", newDocumentXml, {
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });

  // Generate new DOCX
  return zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });
}

/**
 * Update a specific XML file in a DOCX buffer
 *
 * @param originalBuffer - Original DOCX as ArrayBuffer
 * @param path - Path within the ZIP (e.g., "word/styles.xml")
 * @param content - New XML content
 * @param options - Optional repack options
 * @returns Promise resolving to DOCX as ArrayBuffer
 */
export async function updateXmlFile(
  originalBuffer: ArrayBuffer,
  path: string,
  content: string,
  options: RepackOptions = {},
): Promise<ArrayBuffer> {
  const { compressionLevel = 6 } = options;

  const zip = await JSZip.loadAsync(originalBuffer);

  zip.file(path, content, {
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });

  return zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });
}

/**
 * Update multiple files in a DOCX buffer
 *
 * @param originalBuffer - Original DOCX as ArrayBuffer
 * @param updates - Map of path -> content for files to update
 * @param options - Optional repack options
 * @returns Promise resolving to DOCX as ArrayBuffer
 */
export async function updateMultipleFiles(
  originalBuffer: ArrayBuffer,
  updates: Map<string, string | ArrayBuffer>,
  options: RepackOptions = {},
): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(originalBuffer);
  return applyUpdatesToZip(zip, updates, options);
}

/**
 * Apply file updates to an already-loaded JSZip instance and generate the output.
 * Use this when the zip is already loaded to avoid a redundant decompression pass.
 */
export function applyUpdatesToZip(
  zip: JSZip,
  updates: Map<string, string | ArrayBuffer>,
  options: RepackOptions = {},
): Promise<ArrayBuffer> {
  const { compressionLevel = 6 } = options;

  for (const [path, content] of updates) {
    zip.file(path, content, {
      compression: "DEFLATE",
      compressionOptions: { level: compressionLevel },
    });
  }

  return zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });
}

// ============================================================================
// RELATIONSHIP MANAGEMENT
// ============================================================================

/**
 * Add a new relationship to document.xml.rels
 *
 * @param originalBuffer - Original DOCX as ArrayBuffer
 * @param relationship - New relationship to add
 * @returns Promise resolving to { buffer: ArrayBuffer, rId: string }
 */
export async function addRelationship(
  originalBuffer: ArrayBuffer,
  relationship: {
    type: string;
    target: string;
    targetMode?: "External" | "Internal";
  },
): Promise<{ buffer: ArrayBuffer; rId: string }> {
  const zip = await JSZip.loadAsync(originalBuffer);

  // Read existing relationships
  const relsPath = "word/_rels/document.xml.rels";
  const relsFile = zip.file(relsPath);

  if (!relsFile) {
    panic("document.xml.rels not found in DOCX");
  }

  const relsXml = await relsFile.async("text");

  // Generate new rId
  const newRId = `rId${findMaxRId(relsXml) + 1}`;

  // Build new relationship element
  const targetModeAttr =
    relationship.targetMode === "External" ? ' TargetMode="External"' : "";

  const newRelElement = `<Relationship Id="${newRId}" Type="${relationship.type}" Target="${escapeXml(relationship.target)}"${targetModeAttr}/>`;

  // Insert before closing tag
  const updatedRelsXml = relsXml.replace(
    "</Relationships>",
    `${newRelElement}</Relationships>`,
  );

  // Update the ZIP
  zip.file(relsPath, updatedRelsXml);

  const buffer = await zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  return { buffer, rId: newRId };
}

/**
 * Add a media file to the DOCX
 *
 * @param originalBuffer - Original DOCX as ArrayBuffer
 * @param filename - Filename for the media (e.g., "image1.png")
 * @param data - Binary data for the media file
 * @param mimeType - MIME type (e.g., "image/png")
 * @returns Promise resolving to { buffer: ArrayBuffer, rId: string, path: string }
 */
export async function addMedia(
  originalBuffer: ArrayBuffer,
  filename: string,
  data: ArrayBuffer,
  mimeType: string,
): Promise<{ buffer: ArrayBuffer; rId: string; path: string }> {
  const zip = await JSZip.loadAsync(originalBuffer);

  // Determine media path
  const mediaPath = `word/media/${filename}`;

  // Add media file
  zip.file(mediaPath, data);

  // Add relationship
  const relResult = await addRelationship(
    await zip.generateAsync({ type: "arraybuffer" }),
    {
      type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
      target: `media/${filename}`,
    },
  );

  // Update content types if needed
  const contentTypesFile = zip.file("[Content_Types].xml");
  if (contentTypesFile) {
    const contentTypesXml = await contentTypesFile.async("text");
    const extension = filename.split(".").pop()?.toLowerCase() || "";

    // Check if extension is already registered
    const hasExtension = contentTypesXml.includes(`Extension="${extension}"`);

    if (!hasExtension && extension) {
      // Add content type for this extension
      const contentType = getContentTypeForExtension(extension, mimeType);
      const extensionElement = `<Default Extension="${extension}" ContentType="${contentType}"/>`;

      // Insert after other defaults
      const updatedContentTypes = contentTypesXml.replace(
        "</Types>",
        `${extensionElement}</Types>`,
      );

      const finalZip = await JSZip.loadAsync(relResult.buffer);
      finalZip.file("[Content_Types].xml", updatedContentTypes);

      return {
        buffer: await finalZip.generateAsync({
          type: "arraybuffer",
          compression: "DEFLATE",
          compressionOptions: { level: 6 },
        }),
        rId: relResult.rId,
        path: mediaPath,
      };
    }
  }

  return {
    buffer: relResult.buffer,
    rId: relResult.rId,
    path: mediaPath,
  };
}

// ============================================================================
// HEADER/FOOTER SERIALIZATION
// ============================================================================

/**
 * Collect serialized header/footer XML updates from the document model.
 * Uses the relationship map to resolve rId → filename.
 */
const HEADER_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml";
const FOOTER_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml";

/**
 * A header/footer is "unmaterialized" when it lives in the package map but its
 * rId has no resolvable relationship in `document.xml.rels` — i.e. it was
 * created in memory (header editor, watermark coverage) and still lacks a part,
 * relationship, and `[Content_Types]` entry. The selective fast-path can't
 * register those, so it must bail to a full repack when this returns true.
 */
export function hasUnmaterializedHeaderFooter(doc: Document): boolean {
  const rels = doc.package.relationships;
  const hasNew = (
    map: Map<string, HeaderFooter> | undefined,
    type: string,
  ): boolean => {
    if (!map) {
      return false;
    }
    for (const rId of map.keys()) {
      const rel = rels?.get(rId);
      if (!rel || rel.type !== type || !rel.target) {
        return true;
      }
    }
    return false;
  };
  return (
    hasNew(doc.package.headers, RELATIONSHIP_TYPES.header) ||
    hasNew(doc.package.footers, RELATIONSHIP_TYPES.footer)
  );
}

function findMaxHeaderFooterNum(
  zip: JSZip,
  prefix: "header" | "footer",
): number {
  let max = 0;
  const pattern = new RegExp(`^word/${prefix}(\\d+)\\.xml$`, "u");
  zip.forEach((relativePath) => {
    const m = pattern.exec(relativePath);
    if (m) {
      // SAFETY: capture group [1] always present when the regex matches.
      const num = Number.parseInt(m[1]!, 10);
      if (num > max) {
        max = num;
      }
    }
  });
  return max;
}

/**
 * Materialize header/footer parts created in memory (rId present in the package
 * map, absent from `document.xml.rels`). For each: mint a `word/<prefix>N.xml`
 * target, add a document relationship under the *existing* rId (a valid NCName,
 * so the section's `<w:headerReference r:id>` keeps resolving without rewriting
 * document.xml), and a `[Content_Types].xml` Override. The part body is written
 * afterwards by `serializeHeadersFootersToZip`, which can now resolve the new
 * relationship.
 */
async function materializeNewHeaderFooterParts(
  doc: Document,
  zip: JSZip,
  compressionLevel: number,
): Promise<void> {
  const rels = doc.package.relationships;
  if (!rels) {
    return;
  }
  // Cheap guard so the common repack (no in-memory parts) skips the zip scans
  // and rels walk below.
  if (!hasUnmaterializedHeaderFooter(doc)) {
    return;
  }

  const relEntries: string[] = [];
  const overrides: string[] = [];
  let maxHeaderNum = findMaxHeaderFooterNum(zip, "header");
  let maxFooterNum = findMaxHeaderFooterNum(zip, "footer");
  let maxRId = 0;
  for (const id of rels.keys()) {
    const match = /^rId(\d+)$/u.exec(id);
    if (match) {
      // SAFETY: capture group [1] always present when the regex matches.
      const n = Number.parseInt(match[1]!, 10);
      if (n > maxRId) {
        maxRId = n;
      }
    }
  }

  const remapRefs = (
    refs: { rId: string }[] | undefined,
    oldRId: string,
    newRId: string,
  ): void => {
    for (const ref of refs ?? []) {
      if (ref.rId === oldRId) {
        ref.rId = newRId;
      }
    }
  };

  const materialize = (
    map: Map<string, HeaderFooter> | undefined,
    relType: string,
    prefix: "header" | "footer",
    contentType: string,
    isHeader: boolean,
  ): void => {
    if (!map) {
      return;
    }
    for (const rId of [...map.keys()]) {
      const existing = rels.get(rId);
      if (existing && existing.type === relType && existing.target) {
        continue; // Already a materialized part of this kind.
      }
      // When the id is already taken by an unrelated relationship, mint a fresh
      // one and re-point the section references — reusing it would duplicate the
      // id or resolve the header reference to the wrong (non-header) target.
      let effectiveRId = rId;
      if (existing) {
        effectiveRId = `rId${++maxRId}`;
        const headerFooter = map.get(rId);
        if (headerFooter) {
          map.delete(rId);
          map.set(effectiveRId, headerFooter);
        }
        for (const block of doc.package.document.content) {
          if (block.type === "paragraph") {
            remapRefs(
              isHeader
                ? block.sectionProperties?.headerReferences
                : block.sectionProperties?.footerReferences,
              rId,
              effectiveRId,
            );
          }
        }
        const finalProps = doc.package.document.finalSectionProperties;
        remapRefs(
          isHeader
            ? finalProps?.headerReferences
            : finalProps?.footerReferences,
          rId,
          effectiveRId,
        );
      }
      const num = prefix === "header" ? ++maxHeaderNum : ++maxFooterNum;
      const filename = `${prefix}${num}.xml`;
      rels.set(effectiveRId, {
        id: effectiveRId,
        type: relType,
        target: filename,
      });
      relEntries.push(
        `<Relationship Id="${escapeXml(effectiveRId)}" Type="${relType}" Target="${filename}"/>`,
      );
      overrides.push(
        `<Override PartName="/word/${filename}" ContentType="${contentType}"/>`,
      );
    }
  };

  materialize(
    doc.package.headers,
    RELATIONSHIP_TYPES.header,
    "header",
    HEADER_CONTENT_TYPE,
    true,
  );
  materialize(
    doc.package.footers,
    RELATIONSHIP_TYPES.footer,
    "footer",
    FOOTER_CONTENT_TYPE,
    false,
  );

  if (relEntries.length === 0) {
    return;
  }

  const compressionOptions = { level: compressionLevel };
  const relsPath = "word/_rels/document.xml.rels";
  const relsXml = await readRelsOrStub(zip, relsPath);
  zip.file(
    relsPath,
    relsXml.replace(
      "</Relationships>",
      `${relEntries.join("")}</Relationships>`,
    ),
    { compression: "DEFLATE", compressionOptions },
  );

  const ctFile = zip.file("[Content_Types].xml");
  if (ctFile) {
    let ctXml = await ctFile.async("text");
    const missing = overrides.filter((override) => {
      const partName = /PartName="([^"]+)"/u.exec(override)?.[1];
      return partName ? !ctXml.includes(`PartName="${partName}"`) : true;
    });
    if (missing.length > 0) {
      ctXml = ctXml.replace("</Types>", `${missing.join("")}</Types>`);
      zip.file("[Content_Types].xml", ctXml, {
        compression: "DEFLATE",
        compressionOptions,
      });
    }
  }
}

/**
 * A picture watermark is "model-driven" when its raw VML was cleared (so the
 * serializer synthesizes `<v:imagedata r:id>` from `imageRId`). Its image
 * relationship may need rebinding into the header's own rels — work only the
 * full-repack path does — so the selective fast-path bails whenever any such
 * watermark is present, regardless of header count (a single header's rId could
 * have been set without yet resolving in that header's rels).
 */
export function hasModelDrivenPictureWatermark(doc: Document): boolean {
  const headers = doc.package.headers;
  if (!headers) {
    return false;
  }
  for (const hf of headers.values()) {
    if (hf.watermark?.kind === "picture" && !hf.rawWatermarkXml) {
      return true;
    }
  }
  return false;
}

/**
 * Rebind each picture watermark's `imageRId` so it resolves in its own header
 * part's rels. A watermark propagated across headers (or onto a header created
 * by coverage) carries the source header's rId, which is meaningless in a
 * sibling header's `word/_rels/header*.xml.rels`. Per header: keep the rId if
 * it already resolves; otherwise reuse an existing relationship to the same
 * media target, or mint a new one. The media bytes are shared (preserved from
 * the source), so no new media part is written. Raw-replay watermarks are
 * byte-exact and skipped.
 */
async function rebindWatermarkRelIds(
  doc: Document,
  zip: JSZip,
  compressionLevel: number,
): Promise<void> {
  const rels = doc.package.relationships;
  const headers = doc.package.headers;
  if (!rels || !headers) {
    return;
  }

  type PendingHeader = {
    watermark: Extract<Watermark, { kind: "picture" }>;
    relsPath: string;
    partPath: string;
  };
  const pending: PendingHeader[] = [];
  for (const [rId, hf] of headers) {
    const watermark = hf.watermark;
    if (!watermark || watermark.kind !== "picture" || hf.rawWatermarkXml) {
      continue;
    }
    const rel = rels.get(rId);
    if (!rel?.target) {
      continue;
    }
    pending.push({
      watermark,
      relsPath: headerFooterRelsPath(rel.target),
      partPath: headerFooterFilename(rel.target),
    });
  }
  if (pending.length === 0) {
    return;
  }

  // Read every header's rels (keyed by path), not only the ones being rebound:
  // the canonical image may live in a header whose own watermark is raw-replayed
  // (not pending). `document.xml.rels` is excluded — header rIds and body rIds
  // both start at rId1, so it could resolve a watermark to an unrelated body
  // image sharing the rId.
  const relsXmlByPath = new Map<string, string>();
  const headerRelsPaths = new Set<string>(pending.map((p) => p.relsPath));
  for (const rel of rels.values()) {
    if (rel.type === RELATIONSHIP_TYPES.header && rel.target) {
      headerRelsPaths.add(headerFooterRelsPath(rel.target));
    }
  }
  for (const relsPath of headerRelsPaths) {
    relsXmlByPath.set(relsPath, await readRelsOrStub(zip, relsPath));
  }

  // Absolute (package) path the rId maps to in a header's rels, resolved
  // relative to that part — undefined when it is not an image relationship.
  const localImageTarget = (
    relsXml: string,
    relsPath: string,
    imageRId: string,
  ): string | undefined => {
    const rel = parseRelationships(relsXml).get(imageRId);
    return rel?.type === RELATIONSHIP_TYPES.image && rel.target
      ? resolveRelativePath(relsPath, rel.target)
      : undefined;
  };

  // The canonical media (absolute path) the watermark points at: the source
  // header is the one whose own rels maps the rId to an image.
  const resolveCanonical = (imageRId: string): string | undefined => {
    for (const [relsPath, xml] of relsXmlByPath) {
      const target = localImageTarget(xml, relsPath, imageRId);
      if (target) {
        return target;
      }
    }
    return undefined;
  };

  const changedPaths = new Set<string>();
  for (const { watermark, relsPath, partPath } of pending) {
    // Anchored at parse time (absolute imageTarget); fall back to a scan only
    // for watermarks built without a parsed source.
    const canonical =
      watermark.imageTarget ?? resolveCanonical(watermark.imageRId);
    if (!canonical) {
      continue; // Orphaned rId with no embedded media anywhere — cannot invent.
    }
    const relsXml = relsXmlByPath.get(relsPath) ?? EMPTY_RELS_XML;
    if (localImageTarget(relsXml, relsPath, watermark.imageRId) === canonical) {
      // Already resolves to the canonical media. (A local rId resolving to a
      // *different* image — header rIds repeat across parts — must still be
      // rebound.)
      continue;
    }

    const localRels = parseRelationships(relsXml);
    let resolvedRId: string | undefined;
    for (const [id, rel] of localRels) {
      if (
        rel.type === RELATIONSHIP_TYPES.image &&
        rel.target &&
        resolveRelativePath(relsPath, rel.target) === canonical
      ) {
        resolvedRId = id;
        break;
      }
    }
    if (!resolvedRId) {
      resolvedRId = `rId${findMaxRId(relsXml) + 1}`;
      const relativeTarget = relativeTargetForPart(partPath, canonical);
      relsXmlByPath.set(
        relsPath,
        relsXml.replace(
          "</Relationships>",
          `<Relationship Id="${resolvedRId}" Type="${RELATIONSHIP_TYPES.image}" Target="${escapeXml(relativeTarget)}"/></Relationships>`,
        ),
      );
      changedPaths.add(relsPath);
    }
    watermark.imageRId = resolvedRId;
  }

  const compressionOptions = { level: compressionLevel };
  for (const path of changedPaths) {
    const xml = relsXmlByPath.get(path);
    if (xml) {
      zip.file(path, xml, { compression: "DEFLATE", compressionOptions });
    }
  }
}

export function collectHeaderFooterUpdates(doc: Document): Map<string, string> {
  const updates = new Map<string, string>();
  const rels = doc.package.relationships;
  if (!rels) {
    return updates;
  }

  const documentRelsPath = "word/_rels/document.xml.rels";
  const parts: {
    map: Map<string, HeaderFooter> | undefined;
    type: string;
  }[] = [
    { map: doc.package.headers, type: RELATIONSHIP_TYPES.header },
    { map: doc.package.footers, type: RELATIONSHIP_TYPES.footer },
  ];

  for (const { map, type } of parts) {
    if (!map) {
      continue;
    }
    for (const [rId, headerFooter] of map.entries()) {
      const rel = rels.get(rId);
      if (rel && rel.type === type && rel.target) {
        const filename = resolveRelativePath(documentRelsPath, rel.target);
        updates.set(filename, serializeHeaderFooter(headerFooter));
      }
    }
  }

  return updates;
}

/**
 * Serialize modified headers and footers into the ZIP
 */
function serializeHeadersFootersToZip(
  doc: Document,
  zip: JSZip,
  compressionLevel: number,
): void {
  const compressionOptions = { level: compressionLevel };
  for (const [filename, xml] of collectHeaderFooterUpdates(doc)) {
    zip.file(filename, xml, { compression: "DEFLATE", compressionOptions });
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Update core properties XML with new modification date
 */
export function updateCoreProperties(
  corePropsXml: string,
  options: { updateModifiedDate?: boolean; modifiedBy?: string },
): string {
  let result = corePropsXml;

  if (options.updateModifiedDate) {
    const now = new Date().toISOString();

    // Update dcterms:modified
    if (result.includes("<dcterms:modified")) {
      result = result.replace(
        /<dcterms:modified[^>]*>[^<]*<\/dcterms:modified>/u,
        `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>`,
      );
    } else {
      // Add modified date if not present
      result = result.replace(
        "</cp:coreProperties>",
        `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
      );
    }
  }

  if (options.modifiedBy) {
    // Update cp:lastModifiedBy
    if (result.includes("<cp:lastModifiedBy")) {
      result = result.replace(
        /<cp:lastModifiedBy>[^<]*<\/cp:lastModifiedBy>/u,
        `<cp:lastModifiedBy>${escapeXml(options.modifiedBy)}</cp:lastModifiedBy>`,
      );
    } else {
      // Add lastModifiedBy if not present
      result = result.replace(
        "</cp:coreProperties>",
        `<cp:lastModifiedBy>${escapeXml(options.modifiedBy)}</cp:lastModifiedBy></cp:coreProperties>`,
      );
    }
  }

  return result;
}

/**
 * Get content type for a file extension
 */
function getContentTypeForExtension(
  extension: string,
  mimeType: string,
): string {
  // Use provided mime type or fall back to common types
  if (mimeType) {
    return mimeType;
  }

  const contentTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    bmp: "image/bmp",
    tif: "image/tiff",
    tiff: "image/tiff",
    svg: "image/svg+xml",
    webp: "image/webp",
    wmf: "image/x-wmf",
    emf: "image/x-emf",
  };

  return contentTypes[extension] || "application/octet-stream";
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate that a buffer is a valid DOCX file
 *
 * @param buffer - Buffer to validate
 * @returns Promise resolving to validation result
 */
export async function validateDocx(buffer: ArrayBuffer): Promise<{
  valid: boolean;
  errors: string[];
  warnings: string[];
}> {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    const zip = await JSZip.loadAsync(buffer);

    // Check for required files
    const requiredFiles = ["[Content_Types].xml", "word/document.xml"];

    for (const file of requiredFiles) {
      if (!zip.file(file)) {
        errors.push(`Missing required file: ${file}`);
      }
    }

    // Check for recommended files
    const recommendedFiles = [
      "_rels/.rels",
      "word/_rels/document.xml.rels",
      "word/styles.xml",
    ];

    for (const file of recommendedFiles) {
      if (!zip.file(file)) {
        warnings.push(`Missing recommended file: ${file}`);
      }
    }

    // Validate document.xml is valid XML
    const docFile = zip.file("word/document.xml");
    if (docFile) {
      const docXml = await docFile.async("text");

      // Basic XML validation
      if (!docXml.includes("<?xml")) {
        warnings.push("document.xml missing XML declaration");
      }

      if (!docXml.includes("<w:document")) {
        errors.push("document.xml missing w:document element");
      }

      if (!docXml.includes("<w:body>")) {
        errors.push("document.xml missing w:body element");
      }
    }

    // Validate Content_Types.xml
    const ctFile = zip.file("[Content_Types].xml");
    if (ctFile) {
      const ctXml = await ctFile.async("text");

      if (
        !ctXml.includes("word/document.xml") &&
        !ctXml.includes(
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        )
      ) {
        warnings.push(
          "Content_Types.xml may be missing document.xml type declaration",
        );
      }
    }
  } catch (error) {
    errors.push(
      `Failed to read as ZIP: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Check if buffer looks like a DOCX file (quick check)
 *
 * @param buffer - Buffer to check
 * @returns true if buffer starts with ZIP signature
 */
export function isDocxBuffer(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) {
    return false;
  }

  const view = new Uint8Array(buffer);

  // ZIP file signature: PK (0x50, 0x4B)
  return view[0] === 0x50 && view[1] === 0x4b;
}

// ============================================================================
// CREATE NEW DOCX
// ============================================================================

/**
 * Create a new empty DOCX file
 *
 * @returns Promise resolving to minimal DOCX as ArrayBuffer
 */
export function createEmptyDocx(): Promise<ArrayBuffer> {
  const zip = new JSZip();

  // Content Types
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`,
  );

  // Package relationships
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
  );

  // Document relationships
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  );

  // Document
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:r>
        <w:t></w:t>
      </w:r>
    </w:p>
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`,
  );

  // Minimal styles
  zip.file(
    "word/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
        <w:sz w:val="22"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="200" w:line="276" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
</w:styles>`,
  );

  // Core properties
  const now = new Date().toISOString();
  zip.file(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>EigenPal DOCX Editor</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`,
  );

  // App properties
  zip.file(
    "docProps/app.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>EigenPal DOCX Editor</Application>
  <AppVersion>1.0.0</AppVersion>
</Properties>`,
  );

  return zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

/**
 * Create a new DOCX from a Document (without requiring original buffer)
 *
 * @param doc - Document to serialize
 * @returns Promise resolving to DOCX as ArrayBuffer
 */
export async function createDocx(doc: Document): Promise<ArrayBuffer> {
  // Start with an empty DOCX
  const emptyBuffer = await createEmptyDocx();

  // Add document as original buffer
  const docWithBuffer: Document = {
    ...doc,
    originalBuffer: emptyBuffer,
  };

  // Repack with the document content
  return repackDocx(docWithBuffer);
}

// ============================================================================
// EXPORTS
// ============================================================================
