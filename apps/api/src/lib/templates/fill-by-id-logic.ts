/**
 * `templates.fill-by-id`'s fill logic, factored out of the endpoint module
 * (`handlers/templates/fill-by-id.ts`) so that module can keep to one default
 * `{ config, handler }` export while this generator stays directly testable.
 */

import { Result } from "better-result";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { templateFills } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import type { ClauseBody } from "@/api/lib/clauses/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { convertToPdf } from "@/api/lib/files/gotenberg";
import { DOCX_EXT_RE, sanitizeFilename } from "@/api/lib/sanitize-filename";
import type { SecureDocumentResponseOptions } from "@/api/lib/secure-document-response";
import { recordTemplateUse } from "@/api/lib/templates/record-use";
import { containsNull } from "@/api/lib/templates/template-data";
import {
  fillTemplateDocx,
  loadStoredTemplateSource,
} from "@/api/lib/templates/template-fill-service";
import { buildTemplateFillAiWiring } from "@/api/lib/templates/template-fill-usage";
import { isTemplateOutputValid } from "@/api/lib/templates/validate-template-output";
import { DOCX_MIME_TYPE, OCTET_STREAM_MIME_TYPE } from "@/api/mime-types";

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

/** `templates.fill-by-id`'s fill logic: the shared fill pipeline plus this
 *  route's download shaping (PDF conversion, diagnostic headers) and its
 *  use/fill/audit bookkeeping, written in one transaction.
 *
 * @yields safeDb/scopedDb errors out to the parent safe-handler. */
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

  const source = await loadStoredTemplateSource({
    templateId,
    organizationId,
    scopedDb,
  });
  if (!source) {
    return Result.err(
      new HandlerError({ status: 404, message: "Template not found" }),
    );
  }

  const result = await fillTemplateDocx({
    source,
    values,
    scopedDb,
    organizationId,
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
    return Result.err(new HandlerError({ status: 400, message: result.error }));
  }

  const { unusedValues } = result;
  // A failed AI draft leaves its field unfilled, so it counts against the
  // fill the same way an unmatched placeholder does.
  const fillStatus =
    result.unmatchedPlaceholders.length > 0 || result.aiFieldErrors.length > 0
      ? "partial"
      : "success";

  yield* Result.await(
    Result.tryPromise({
      try: async () =>
        await scopedDb(async (tx) => {
          await recordTemplateUse({ tx, templateId });
          await tx.insert(templateFills).values({
            organizationId,
            templateId,
            userId,
            format,
            status: fillStatus,
            unmatchedCount: result.unmatchedPlaceholders.length,
            unusedCount: unusedValues.length,
            structureErrors:
              result.structureErrors.length > 0 ? result.structureErrors : null,
          });

          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.DOWNLOAD,
            resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
            resourceId: templateId,
            workspaceId: null,
            metadata: {
              format,
              status: fillStatus,
              unmatchedCount: result.unmatchedPlaceholders.length,
            },
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

  const additionalHeaders = new Headers();
  if (result.aiFieldErrors.length > 0) {
    additionalHeaders.set(
      "X-Ai-Field-Errors",
      encodeURIComponent(JSON.stringify(result.aiFieldErrors)),
    );
  }

  // PDF conversion via Gotenberg
  if (format === "pdf") {
    const docxBytes = new Uint8Array(result.buffer);
    if (
      !(await isTemplateOutputValid({
        buffer: docxBytes,
        fileName: baseName,
      }))
    ) {
      return Result.err(
        new HandlerError({ status: 422, message: "Template output invalid" }),
      );
    }
    const pdfResult = await convertToPdf(
      docxBytes.buffer.slice(
        docxBytes.byteOffset,
        docxBytes.byteOffset + docxBytes.byteLength,
      ),
      baseName,
      DOCX_MIME_TYPE,
    );
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

  if (result.unmatchedPlaceholders.length > 0) {
    additionalHeaders.set(
      "X-Unmatched-Placeholders",
      // Headers are ISO-8859-1; field paths carry diacritics (Polish/Czech),
      // so the diagnostic lists travel URI-encoded.
      encodeURIComponent(result.unmatchedPlaceholders.join(",")),
    );
  }
  if (unusedValues.length > 0) {
    additionalHeaders.set(
      "X-Unused-Values",
      encodeURIComponent(unusedValues.join(",")),
    );
  }
  if (result.structureErrors.length > 0) {
    additionalHeaders.set(
      "X-Structure-Errors",
      JSON.stringify(result.structureErrors),
    );
  }
  return Result.ok({
    additionalHeaders,
    body: new Uint8Array(result.buffer),
    // Octet-stream, not the DOCX mime type: the Eden treaty client
    // text-decodes unrecognized content types, which corrupts the ZIP
    // container (Word then reports unreadable content).
    contentType: OCTET_STREAM_MIME_TYPE,
    disposition: "attachment",
    fileName: sanitizeFilename(baseName),
  } satisfies SecureDocumentResponseOptions);
};
