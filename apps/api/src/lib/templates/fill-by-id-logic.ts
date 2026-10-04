import { Result } from "better-result";
/**
 * `templates.fills.download`'s fill logic, factored out of the endpoint module
 * (`handlers/templates/fills/download.ts`) so that module can keep to one default
 * `{ config, handler }` export while this generator stays directly testable.
 */

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION } from "@/api/lib/audit-log";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { SafeId } from "@/api/lib/branded-types";
import type { ClauseBody } from "@/api/lib/clauses/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { convertToPdf } from "@/api/lib/files/gotenberg";
import { DOCX_EXT_RE, sanitizeFilename } from "@/api/lib/sanitize-filename";
import type { SecureDocumentResponseOptions } from "@/api/lib/secure-document-response";
import { fillDiagnosticHeaders } from "@/api/lib/templates/fill-diagnostic-headers";
import {
  recordTemplateFill,
  recordTemplateUse,
} from "@/api/lib/templates/record-use";
import { containsNull } from "@/api/lib/templates/template-data";
import { fillDiagnosticsOf } from "@/api/lib/templates/template-fill-completion";
import {
  fillTemplateDocx,
  loadStoredTemplateSource,
} from "@/api/lib/templates/template-fill-service";
import { buildTemplateFillAiWiring } from "@/api/lib/templates/template-fill-usage";
import { scanTemplateOutput } from "@/api/lib/templates/validate-template-output";
import { OCTET_STREAM_MIME_TYPE } from "@/api/mime-types";

export type FillByIdLogicProps = {
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  templateId: SafeId<"template">;
  body: {
    values: Record<string, unknown>;
    clauseOverrides?: Record<string, ClauseBody>;
  };
  query: { format?: "docx" | "pdf" };
  recordAuditEvent: AuditRecorder;
};

/** `templates.fills.download`'s fill logic: the shared fill pipeline plus this
 *  route's download shaping (PDF conversion, diagnostic headers) and its
 *  use/fill/audit bookkeeping, written in one transaction.
 *
 * @yields safeDb/scopedDb errors and stored-template load failures (404, a
 * 422 scan rejection, a 503 scanner outage) out to the parent safe-handler. */
export const fillByIdLogic = async function* ({
  safeDb,
  scopedDb,
  organizationId,
  userId,
  templateId,
  body: { values, clauseOverrides },
  query: { format = "docx" },
  recordAuditEvent,
}: FillByIdLogicProps) {
  if (Object.values(values).some(containsNull)) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "'values' must not contain null values.",
      }),
    );
  }

  const source = yield* Result.await(
    loadStoredTemplateSource({ templateId, organizationId, scopedDb }),
  );

  const result = await fillTemplateDocx({
    source,
    values,
    scopedDb,
    organizationId,
    thirdPartyOutboundPermit: grantThirdPartyOutboundPermit(),
    clauseOverrides,
    // A required, user-entered field left absent or empty must never download
    // as an invented value or a raw `{{marker}}`.
    requiredFields: "enforce",
    // The use count is written below, inside this route's own bookkeeping
    // transaction, alongside the fill row and the audit event.
    useRecording: "caller",
    ...buildTemplateFillAiWiring({
      organizationId,
      userId,
      safeDb,
      scopedDb,
      feature: "templates.fill",
      documentLanguages: source.documentLanguages,
    }),
  });

  if ("requiredFieldsRejection" in result) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Missing required template values: ${result.requiredFieldsRejection
          .map((field) => field.label ?? field.path)
          .join(", ")}`,
        // The message alone loses each field's input type/options; carry the
        // full rejection so a client can render the right control per field
        // and retry with all of them at once.
        requiredFields: result.requiredFieldsRejection,
      }),
    );
  }
  if ("usageRejection" in result) {
    return Result.err(result.usageRejection);
  }
  if ("error" in result) {
    return Result.err(
      result.storedTemplateError ??
        new HandlerError({ status: 400, message: result.error }),
    );
  }

  // The recorded status is the completion decision over every diagnostic: a
  // failed AI draft, an undecided AI condition or an unresolved clause counts
  // against the fill the same way an unmatched placeholder does.
  const diagnostics = fillDiagnosticsOf(result);

  yield* Result.await(
    Result.tryPromise({
      try: async () =>
        await scopedDb(async (tx) => {
          await recordTemplateUse({ tx, templateId });
          // A download from the template library: no workspace.
          await recordTemplateFill({
            tx,
            templateId,
            organizationId,
            userId,
            format,
            diagnostics,
            recordAuditEvent,
            auditAction: AUDIT_ACTION.DOWNLOAD,
          });
        }),
      catch: (cause) =>
        new HandlerError({
          status: 500,
          message: "Template fill audit failed",
          cause,
        }),
    }),
  );

  const baseName = result.fileName;

  const additionalHeaders = fillDiagnosticHeaders({ diagnostics, format });

  // PDF conversion via Gotenberg
  if (format === "pdf") {
    const scannedOutput = await scanTemplateOutput({
      buffer: new Uint8Array(result.file.bytes),
      fileName: baseName,
    });
    if (scannedOutput === null) {
      return Result.err(
        new HandlerError({ status: 422, message: "Template output invalid" }),
      );
    }
    const pdfResult = await convertToPdf(scannedOutput);
    if (Result.isError(pdfResult)) {
      return Result.err(
        new HandlerError({
          status: 502,
          message: "PDF conversion failed",
        }),
      );
    }

    const pdfName = DOCX_EXT_RE.test(baseName)
      ? baseName.replace(DOCX_EXT_RE, ".pdf")
      : `${baseName}.pdf`;
    // The literal file-response construction stays in the endpoint module
    // (fill-by-id.ts calls secureDocumentResponse on this payload): the
    // capability-catalog exporter statically scans each handler module's own
    // source for that call, so returning the ready-made Response from here
    // instead would make its declared file-response transport look stale.
    return Result.ok({
      additionalHeaders,
      body: new Uint8Array(pdfResult.value.buffer),
      // Octet-stream, not application/pdf: see OCTET_STREAM_MIME_TYPE.
      contentType: OCTET_STREAM_MIME_TYPE,
      disposition: "attachment",
      fileName: sanitizeFilename(pdfName),
    } satisfies SecureDocumentResponseOptions);
  }

  return Result.ok({
    additionalHeaders,
    body: new Uint8Array(result.file.bytes),
    // Octet-stream, not the DOCX mime type: the Eden treaty client
    // text-decodes unrecognized content types, which corrupts the ZIP
    // container (Word then reports unreadable content).
    contentType: OCTET_STREAM_MIME_TYPE,
    disposition: "attachment",
    fileName: sanitizeFilename(baseName),
  } satisfies SecureDocumentResponseOptions);
};
