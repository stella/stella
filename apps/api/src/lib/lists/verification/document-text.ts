/**
 * The text a verification reads, as ordered blocks the model cites by id.
 *
 * A DOCX is read through Folio, so a claim anchors to a block the editor can
 * scroll to. A PDF is read page by page from its own bytes, unstamped, so a
 * claim anchors to a page and to offsets inside that page's text. Anything
 * else is refused rather than guessed at.
 */

import { envBase } from "@/api/env-base";
import type { SafeId } from "@/api/lib/branded-types";
import { openScannedDocxReviewer } from "@/api/lib/file-scan/document-parsers";
import { readStoredFile } from "@/api/lib/file-scan/stored-file";
import { readPdfPageTexts } from "@/api/lib/files/pdf-page-text";
import type { PdfLineBox } from "@/api/lib/files/pdf-page-text";
import { createFileKey } from "@/api/lib/files/utils";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { readS3ObjectBounded } from "@/api/lib/s3";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";

/** Where a block sits in the source, which a claim's anchor extends. */
type VerificationBlockSource =
  | { type: "docx-block"; blockId: string }
  | { type: "pdf-page"; pageNumber: number };

/**
 * What the reader saw of a block's shape, which paragraph scoping reads
 * (`paragraph-scope.ts`): a DOCX paragraph's shown label (Word's automatic
 * `82.` is not in its text) and whether it is a heading, or a PDF page's line
 * boxes, one per line of its text. Never sent to the model, never stored.
 */
type VerificationBlockStructure =
  | { type: "docx-paragraph"; label: string | null; heading: boolean }
  | { type: "pdf-lines"; boxes: readonly PdfLineBox[] | null };

export type VerificationBlock = {
  /** The id the model cites: the Folio block id, or `P<page>` for a PDF. */
  id: string;
  text: string;
  source: VerificationBlockSource;
  /** Absent on a block built from plain text: it reads as unlabelled
   *  prose, and a PDF page's lines as lines without geometry. */
  structure?: VerificationBlockStructure;
};

type VerificationFile = {
  fileId: string;
  mimeType: string;
  /** The converted PDF of a non-PDF upload; used when the upload is not DOCX. */
  pdfFileId: string | null;
};

type ReadVerificationDocumentArgs = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  file: VerificationFile;
  signal: AbortSignal;
};

export type VerificationDocument =
  | { type: "read"; blocks: VerificationBlock[] }
  | { type: "unsupported-format" }
  | { type: "no-text" };

const pdfPageId = (pageNumber: number): string => `P${String(pageNumber)}`;

/** The id of the block a stored source names: what a run's scope edges
 *  point at. */
export const verificationBlockId = (source: VerificationBlockSource): string =>
  source.type === "docx-block" ? source.blockId : pdfPageId(source.pageNumber);

const readPdfBlocks = async (
  bytes: Uint8Array,
): Promise<VerificationBlock[]> => {
  const blocks: VerificationBlock[] = [];
  for (const { pageNumber, text, lineBoxes } of await readPdfPageTexts({
    bytes,
  })) {
    if (text.trim().length === 0) {
      continue;
    }
    blocks.push({
      id: pdfPageId(pageNumber),
      text,
      source: { type: "pdf-page", pageNumber },
      structure: { type: "pdf-lines", boxes: lineBoxes },
    });
  }
  return blocks;
};

export const readVerificationDocument = async ({
  organizationId,
  workspaceId,
  file,
  signal,
}: ReadVerificationDocumentArgs): Promise<VerificationDocument> => {
  if (file.mimeType === DOCX_MIME_TYPE) {
    const key = createFileKey({
      organizationId,
      workspaceId,
      fileId: file.fileId,
      mimeType: DOCX_MIME_TYPE,
    });
    // Bounded and cancellable like the PDF read below, so a stalled read
    // ends at the caller's deadline.
    const reviewer = await openScannedDocxReviewer(
      await readStoredFile({
        key,
        mimeType: DOCX_MIME_TYPE,
        maxBytes: FILE_SIZE_LIMIT_BYTES.document,
        signal,
      }),
    );
    const blocks = reviewer
      .getContent()
      .filter((block) => block.text.trim().length > 0)
      .map((block): VerificationBlock => ({
        id: block.id,
        text: block.text,
        source: { type: "docx-block", blockId: block.id },
        structure: {
          type: "docx-paragraph",
          label: block.displayLabel ?? null,
          heading: block.headingLevel !== undefined,
        },
      }));
    return blocks.length === 0 ? { type: "no-text" } : { type: "read", blocks };
  }

  const pdfFileId =
    file.mimeType === PDF_MIME_TYPE ? file.fileId : file.pdfFileId;
  if (pdfFileId === null) {
    return { type: "unsupported-format" };
  }
  const key = createFileKey({
    organizationId,
    workspaceId,
    fileId: pdfFileId,
    mimeType: PDF_MIME_TYPE,
  });
  // A rendition is never larger than an upload may be; a bigger object is
  // refused before its body is read.
  const blocks = await readPdfBlocks(
    await readS3ObjectBounded({
      bucket: envBase.S3_BUCKET,
      key,
      maxBytes: FILE_SIZE_LIMIT_BYTES.document,
      signal,
    }),
  );
  // A scan without a text layer reads as nothing; saying so beats verifying
  // an empty document and reporting that no claims were found.
  return blocks.length === 0 ? { type: "no-text" } : { type: "read", blocks };
};
