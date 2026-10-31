/**
 * Download a matter document's PDF with the caller's visible marks written
 * in as PDF annotations, as the export mode says: highlights alone for the
 * plain Download of a PDF in the app, or with comments and author names.
 *
 * Which marks are visible is the annotation listing's to decide (the caller's
 * own and what colleagues on the matter shared, under row-level security), so
 * the copy carries exactly what that caller's viewer shows and nothing more.
 * The stored version is untouched, and a file that cannot take the marks
 * without harm (a certification that forbids annotations, encryption, bytes
 * LibPDF cannot append to) is handed over exactly as stored.
 */

import { Result } from "better-result";

import type { MarkedPdfExportMode } from "@stll/api-contract/marked-pdf-export";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readStoredFile } from "@/api/lib/file-scan/stored-file";
import { writeMarksIntoPdf } from "@/api/lib/files/marked-pdf";
import type { PdfMark } from "@/api/lib/files/marked-pdf";
import { displayedPdfFileId, fileFieldQuery } from "@/api/lib/files/read-file";
import { createFileKey } from "@/api/lib/files/utils";
import { readAllVisibleMatterDocumentMarks } from "@/api/lib/legal-search/reader-annotations/matter-document-list";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { openS3ObjectStreamWithSignal } from "@/api/lib/s3";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";
import { withTimeout } from "@/api/lib/with-timeout";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const MARKED_DOWNLOAD_READ_TIMEOUT_MS = 60 * 1000;
const MARKED_DOWNLOAD_FAILURE = failureSink({
  event: "files.marked_download.failed",
  expected: [],
});

type MarkedDownloadOptions = {
  fieldId: SafeId<"field">;
  mode: MarkedPdfExportMode;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  requestSignal: AbortSignal;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

export const readMarkedDownload = async function* ({
  fieldId,
  mode,
  organizationId,
  recordAuditEvent,
  requestSignal,
  safeDb,
  scopedDb,
  userId,
  workspaceId,
}: MarkedDownloadOptions) {
  const row = (yield* Result.await(
    Result.tryPromise(
      async () => await fileFieldQuery(scopedDb, fieldId, workspaceId),
    ),
  )).at(0);
  if (!row) {
    return Result.err(
      new HandlerError({ status: 404, message: "File not found" }),
    );
  }
  if (row.content.type !== "file") {
    return Result.err(
      new HandlerError({ status: 400, message: "The field holds no file" }),
    );
  }
  const content = row.content;
  if (content.mimeType !== PDF_MIME_TYPE) {
    return Result.err(
      new HandlerError({ status: 400, message: "The file is not a PDF." }),
    );
  }
  const key = createFileKey({
    organizationId,
    workspaceId,
    fileId: content.id,
    mimeType: content.mimeType,
  });
  const marked = (
    await Result.tryPromise(
      async () =>
        await Result.gen(async function* () {
          if (
            content.encrypted ||
            content.sizeBytes > FILE_SIZE_LIMIT_BYTES.document
          ) {
            return Result.ok(null);
          }
          // Marks anchor to the PDF the viewer shows; only the upload itself
          // has offsets that index these bytes.
          let marks: readonly PdfMark[] = [];
          if (displayedPdfFileId(content) === content.id) {
            const visible = yield* readAllVisibleMatterDocumentMarks({
              entityId: row.entityId,
              fieldId,
              organizationId,
              safeDb,
              userId,
              workspaceId,
            });
            marks = yield* visible;
          }
          if (marks.length === 0) {
            return Result.ok(null);
          }
          const stored = yield* Result.await(
            Result.tryPromise(
              async () =>
                await withTimeout(
                  async (signal) =>
                    await readStoredFile({
                      key,
                      mimeType: content.mimeType,
                      maxBytes: FILE_SIZE_LIMIT_BYTES.document,
                      signal: AbortSignal.any([signal, requestSignal]),
                    }),
                  {
                    label: "Marked download storage read",
                    timeoutMs: MARKED_DOWNLOAD_READ_TIMEOUT_MS,
                  },
                ),
            ),
          );
          const copy = yield* Result.await(
            Result.tryPromise(
              async () =>
                await writeMarksIntoPdf({
                  marks,
                  mode,
                  source: new Uint8Array(stored.bytes),
                  viewedFieldId: fieldId,
                }),
            ),
          );
          return Result.ok(copy.status === "marked" ? copy : null);
        }),
    )
  ).andThen((result) => result);
  if (marked.isErr()) {
    observeFailure(marked.error, {
      sink: MARKED_DOWNLOAD_FAILURE,
      ctx: { mode },
    });
  }
  // Every unavailable marking outcome serves the same authorized original.
  // Streaming keeps the processing ceiling from becoming a download ceiling.
  const copy = marked.unwrapOr(null);
  const download =
    copy === null
      ? yield* Result.await(
          Result.tryPromise(
            async () => await openS3ObjectStreamWithSignal(key, requestSignal),
          ),
        )
      : {
          body: copy.bytes.slice().buffer,
          contentLength: copy.bytes.byteLength,
        };

  // Recorded once the copy exists, as the other download paths do: a failed
  // read must not leave a download in the trail that never happened.
  yield* Result.await(
    Result.tryPromise(
      async () =>
        await scopedDb(
          async (tx) =>
            await recordAuditEvent(tx, {
              action: AUDIT_ACTION.DOWNLOAD,
              resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
              resourceId: row.entityId,
              metadata: {
                fieldId,
                mimeType: content.mimeType,
                annotations: copy?.annotationCount ?? 0,
                markExport: mode,
              },
            }),
        ),
    ),
  );

  return Result.ok(
    secureDocumentResponse({
      body: download.body,
      ...(download.contentLength === undefined
        ? {}
        : { contentLength: download.contentLength }),
      contentType: PDF_MIME_TYPE,
      disposition: "attachment",
      fileName: sanitizeFilename(content.fileName),
    }),
  );
};
