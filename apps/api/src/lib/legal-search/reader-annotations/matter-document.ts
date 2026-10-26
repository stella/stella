/**
 * The file a mark on a matter document sits on, and its page texts. The file
 * is the field the reader had open, read under the caller's matter scope from
 * a live version of the document; its words are read from the very PDF the
 * viewer shows (`displayedPdfFileId`), with the extractor the viewer uses.
 */

import { panic, Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import { MATTER_DOCUMENT_ANNOTATION_REFUSALS } from "@stll/api-contract/legal-reader-annotations";

import type { Transaction } from "@/api/db/root";
import { entityVersions, fields } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readStoredFile } from "@/api/lib/file-scan/stored-file";
import { readPdfPageTexts } from "@/api/lib/files/pdf-page-text";
import { displayedPdfFileId } from "@/api/lib/files/read-file";
import { createFileKey } from "@/api/lib/files/utils";
import { placeDocumentSpans } from "@/api/lib/legal-search/reader-annotations/matter-document.logic";
import type {
  DocumentPageSpan,
  DocumentSpanRefusal,
  PlacedDocumentSpans,
} from "@/api/lib/legal-search/reader-annotations/matter-document.logic";
import type { MatterDocumentRef } from "@/api/lib/legal-search/reader-annotations/target";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { PDF_MIME_TYPE } from "@/api/mime-types";

/** Long enough for the largest document a matter may hold to download. */
const MARKED_PDF_READ_TIMEOUT_MS = 60_000;

export type MarkedDocumentField = {
  content: (typeof fields.$inferSelect)["content"];
  propertyId: SafeId<"property">;
};

/**
 * The field, if the caller can see it as a file of a live version of the
 * document in this matter: the field's and the version's row policies decide,
 * so a field of another matter, document or organization reads as absent.
 */
export const readMarkedDocumentField = async ({
  entityId,
  fieldId,
  tx,
  workspaceId,
}: MatterDocumentRef & {
  tx: Pick<Transaction, "select">;
}): Promise<MarkedDocumentField | undefined> =>
  (
    await tx
      .select({ content: fields.content, propertyId: fields.propertyId })
      .from(fields)
      .innerJoin(
        entityVersions,
        and(
          eq(entityVersions.id, fields.entityVersionId),
          eq(entityVersions.workspaceId, workspaceId),
        ),
      )
      .where(
        and(
          eq(fields.id, fieldId),
          eq(fields.workspaceId, workspaceId),
          eq(entityVersions.entityId, entityId),
          isNull(entityVersions.deletedAt),
        ),
      )
      .limit(1)
  ).at(0);

export const documentFileNotFound = () =>
  new HandlerError({ status: 404, message: "Document file not found" });

/** The PDF a mark's words are read from, or why this file cannot carry one. */
const markedPdfFileId = (
  content: MarkedDocumentField["content"],
): Result<string, HandlerError<404 | 422>> => {
  if (content.type !== "file") {
    return Result.err(documentFileNotFound());
  }
  if (content.encrypted) {
    return Result.err(
      new HandlerError({
        status: 422,
        code: MATTER_DOCUMENT_ANNOTATION_REFUSALS.fileEncrypted,
        message: "An encrypted file cannot carry highlights or comments.",
        hint: "Mark a copy of the document that is not encrypted.",
      }),
    );
  }
  const pdfFileId = displayedPdfFileId(content);
  if (pdfFileId === null) {
    return Result.err(
      new HandlerError({
        status: 422,
        code: MATTER_DOCUMENT_ANNOTATION_REFUSALS.fileNotPdf,
        message:
          "Only a PDF, or a document with a PDF rendition, can carry highlights or comments.",
        hint: "Open the document in its PDF view, or wait for its PDF rendition, then select the words again.",
      }),
    );
  }
  return Result.ok(pdfFileId);
};

const spanRefusalError = ({
  code,
  pageNumber,
}: DocumentSpanRefusal): HandlerError<409 | 422> => {
  switch (code) {
    case MATTER_DOCUMENT_ANNOTATION_REFUSALS.pageMissing: {
      return new HandlerError({
        status: 422,
        code,
        message: `Page ${String(pageNumber)} is not in this document.`,
        hint: "Reload the document and select the words again.",
      });
    }
    case MATTER_DOCUMENT_ANNOTATION_REFUSALS.pageWithoutText: {
      return new HandlerError({
        status: 422,
        code,
        message: `Page ${String(pageNumber)} has no text to mark.`,
        hint: "Run text recognition (OCR) on the document, then select the words again.",
      });
    }
    case MATTER_DOCUMENT_ANNOTATION_REFUSALS.quoteMismatch: {
      return new HandlerError({
        status: 409,
        code,
        message: `The selected words are not on page ${String(pageNumber)} as the document reads.`,
        hint: "Reload the document and select the words again.",
      });
    }
    default: {
      code satisfies never;
      return panic(`Unhandled span refusal: ${String(code)}`);
    }
  }
};

type PlaceMatterDocumentSpansOptions = {
  field: MarkedDocumentField;
  organizationId: SafeId<"organization">;
  spans: readonly DocumentPageSpan[];
  workspaceId: SafeId<"workspace">;
};

/**
 * Places a new mark's spans on the pages of the file the reader had open. The
 * PDF is read outside any transaction, so the download and the extraction
 * hold no database connection. A file whose bytes change before the mark is
 * stored is not refused: the digest stored with the mark then differs from
 * the page the viewer reads, which is what shows the mark as detached.
 */
export const placeMatterDocumentSpans = async ({
  field,
  organizationId,
  spans,
  workspaceId,
}: PlaceMatterDocumentSpansOptions): Promise<
  Result<PlacedDocumentSpans, HandlerError>
> => {
  const pdfFileId = markedPdfFileId(field.content);
  if (Result.isError(pdfFileId)) {
    return Result.err(pdfFileId.error);
  }
  const stored = await Result.tryPromise({
    try: async () =>
      await readStoredFile({
        key: createFileKey({
          organizationId,
          workspaceId,
          fileId: pdfFileId.value,
          mimeType: PDF_MIME_TYPE,
        }),
        mimeType: PDF_MIME_TYPE,
        maxBytes: FILE_SIZE_LIMIT_BYTES.document,
        signal: AbortSignal.timeout(MARKED_PDF_READ_TIMEOUT_MS),
      }),
    catch: (cause) =>
      new HandlerError({
        status: 502,
        code: "upstream_unavailable",
        message: "The document could not be read from storage.",
        hint: "Try again in a moment.",
        retryable: true,
        retryAfterMs: 1000,
        cause,
      }),
  });
  if (Result.isError(stored)) {
    return Result.err(stored.error);
  }
  // Bytes that do not parse as a PDF are the file's own fault, not the
  // storage's: the reader can do nothing but mark another file.
  const pages = await Result.tryPromise({
    try: async () =>
      await readPdfPageTexts({
        bytes: new Uint8Array(stored.value.bytes),
        pageNumbers: new Set(spans.map((span) => span.pageNumber)),
      }),
    catch: (cause) =>
      new HandlerError({
        status: 422,
        code: MATTER_DOCUMENT_ANNOTATION_REFUSALS.fileNotPdf,
        message: "This PDF cannot be read, so its words cannot be marked.",
        hint: "Upload a new version of the document, then select the words again.",
        cause,
      }),
  });
  if (Result.isError(pages)) {
    return Result.err(pages.error);
  }
  const placed = placeDocumentSpans({
    pages: new Map(
      pages.value.map(({ pageNumber, text }) => [pageNumber, text]),
    ),
    spans,
  });
  return Result.isError(placed)
    ? Result.err(spanRefusalError(placed.error))
    : Result.ok(placed.value);
};
