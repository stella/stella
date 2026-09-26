/**
 * The folio-core entry points that parse DOCX bytes, behind `ScannedFile`.
 *
 * folio-core accepts raw bytes, so without this module any caller could hand
 * it an upload the security scan never saw. The `scanned-file-boundary` lint
 * rule reports imports of these functions from folio-core anywhere else (the
 * extraction worker, which receives already scanned bytes over stdin, is the
 * one other owner). Nothing here imports the scanner, so stored-file readers
 * that parse documents do not bundle its native addon.
 *
 * folio's own re-serialization of a `ScannedFile` is returned as a derived
 * `ScannedFile`: those bytes are the parser's output for scanned input, not
 * new untrusted content.
 */
import { compareDocx } from "@stll/folio-core";
import {
  applyFolioAIEditsToBuffer,
  compareDocxVersions,
  createBilingualDocx,
  docxToMarkdown,
  extractDocumentStyleSetFromDocx,
  extractDocxText,
  FolioDocxReviewer,
  materializeYjsDocx,
  parseDocx,
  readBilingualDocx,
} from "@stll/folio-core/server";

import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { mintScannedFile } from "@/api/lib/file-scan/scanned-file";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";

/**
 * folio output for a `ScannedFile` input. Exported for the one other module
 * that re-serializes documents itself (`document-translation/docx-review.ts`);
 * the lint rule restricts the import to it.
 */
export const derivedScannedFile = (
  file: ScannedFile,
  bytes: ArrayBuffer | Uint8Array,
): ScannedFile =>
  mintScannedFile({
    bytes: new Uint8Array(bytes).buffer,
    fileName: sanitizeFilename(file.fileName),
    mimeType: file.mimeType,
    source: { type: "derived", from: file.source },
  });

export const parseScannedDocx = async (
  file: ScannedFile,
  options?: Parameters<typeof parseDocx>[1],
) => await parseDocx(file.bytes, options);

export const scannedDocxToMarkdown = async (
  file: ScannedFile,
  options?: Parameters<typeof docxToMarkdown>[1],
) => await docxToMarkdown(file.bytes, options);

export const extractScannedDocxText = async (file: ScannedFile) =>
  await extractDocxText(file.bytes);

export const compareScannedDocx = async (
  base: ScannedFile,
  target: ScannedFile,
  options: Parameters<typeof compareDocx>[2],
) => await compareDocx(base.bytes, target.bytes, options);

export const compareScannedDocxVersions = async (
  base: ScannedFile,
  revised: ScannedFile,
  options?: Parameters<typeof compareDocxVersions>[2],
) => await compareDocxVersions(base.bytes, revised.bytes, options);

/** The bilingual document, with its bytes also as a derived `ScannedFile`. */
export const createBilingualDocxFromScanned = async (
  file: ScannedFile,
  options: Parameters<typeof createBilingualDocx>[1],
) => {
  const result = await createBilingualDocx(file.bytes, options);
  return { ...result, file: derivedScannedFile(file, result.buffer) };
};

export const readScannedBilingualDocx = async (file: ScannedFile) =>
  await readBilingualDocx(file.bytes);

export const extractScannedDocumentStyleSet = async (
  file: ScannedFile,
  options: Parameters<typeof extractDocumentStyleSetFromDocx>[1],
) => await extractDocumentStyleSetFromDocx(file.bytes, options);

export const applyFolioAIEditsToScannedDocx = async (
  file: ScannedFile,
  operations: Parameters<typeof applyFolioAIEditsToBuffer>[1],
  options?: Parameters<typeof applyFolioAIEditsToBuffer>[2],
) => await applyFolioAIEditsToBuffer(file.bytes, operations, options);

/** A collaborative Yjs state materialized over its scanned source document. */
export const materializeYjsOverScannedDocx = async ({
  source,
  yjsUpdate,
}: {
  source: ScannedFile;
  yjsUpdate: Uint8Array;
}) => await materializeYjsDocx({ sourceDocx: source.bytes, yjsUpdate });

export const openScannedDocxReviewer = async (
  file: ScannedFile,
  options?: Parameters<typeof FolioDocxReviewer.fromBuffer>[1],
) => await FolioDocxReviewer.fromBuffer(file.bytes, options);

/** The document with every tracked change accepted or rejected. */
export const resolveScannedTrackedChanges = async (
  file: ScannedFile,
  resolution: "accept" | "reject",
): Promise<ScannedFile> => {
  const reviewer = await FolioDocxReviewer.fromBuffer(file.bytes);
  if (resolution === "accept") {
    reviewer.acceptAll();
  } else {
    reviewer.rejectAll();
  }
  return derivedScannedFile(file, await reviewer.toBuffer());
};
