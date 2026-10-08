import { Result } from "better-result";
import { t } from "elysia";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { captureError } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { SafeId } from "@/api/lib/branded-types";
import { isTemplateData } from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { convertToPdf } from "@/api/lib/files/gotenberg";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { DOCX_EXT_RE, sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";
import { fillDiagnosticHeaders } from "@/api/lib/templates/fill-diagnostic-headers";
import { recordTemplateFill } from "@/api/lib/templates/record-use";
import {
  scanTemplateUpload,
  templateUploadRejectionResponse,
} from "@/api/lib/templates/scan-template-upload";
import { containsNull } from "@/api/lib/templates/template-data";
import { fillDiagnosticsOf } from "@/api/lib/templates/template-fill-completion";
import { fillTemplateDocx } from "@/api/lib/templates/template-fill-service";
import { buildTemplateFillAiWiring } from "@/api/lib/templates/template-fill-usage";
import { scanTemplateOutput } from "@/api/lib/templates/validate-template-output";
import { isRecord } from "@/api/lib/type-guards";
import { DOCX_MIME_TYPE, OCTET_STREAM_MIME_TYPE } from "@/api/mime-types";

const fillBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.document }),
  values: t.String({ description: "Map of field path to value." }),
});

const fillQuerySchema = t.Object({
  format: t.Optional(t.Union([t.Literal("docx"), t.Literal("pdf")])),
});

type FillProps = {
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  body: { file: File; values: string };
  query: { format?: "docx" | "pdf" };
};

/** Serialize a preflight `HandlerError` to the same JSON body the framework
 *  preflight returns (message plus the 402 usage detail), for this route's
 *  raw-Response download path. */
const usageRejectionResponse = (error: HandlerError): Response =>
  new Response(
    JSON.stringify({
      ...(error.code ? { code: error.code } : {}),
      message: error.message,
      ...(error.hint ? { hint: error.hint } : {}),
      ...(error.contactUrl ? { contactUrl: error.contactUrl } : {}),
      ...(error.usage
        ? {
            reason: error.usage.reason,
            required: error.usage.required,
            available: error.usage.available,
          }
        : {}),
    }),
    {
      status: error.status,
      headers: { "Content-Type": "application/json" },
    },
  );

export const fillHandler = async ({
  safeDb,
  scopedDb,
  organizationId,
  userId,
  body: { file, values: valuesJson },
  query: { format = "docx" },
}: FillProps) => {
  if (file.type !== DOCX_MIME_TYPE) {
    return new Response(
      JSON.stringify({
        error: "Invalid file type. Expected a DOCX file.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const parseResult = Result.try((): unknown => JSON.parse(valuesJson));
  if (Result.isError(parseResult)) {
    return new Response(
      JSON.stringify({
        error: "Invalid JSON in 'values' field.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const parsed = parseResult.value;
  if (!isRecord(parsed)) {
    return new Response(
      JSON.stringify({
        error: "'values' must be a JSON object (not null or array).",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const hasNullValue = Object.values(parsed).some(containsNull);
  if (hasNullValue) {
    return new Response(
      JSON.stringify({
        error: "'values' must not contain null values.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!isTemplateData(parsed)) {
    return new Response(
      JSON.stringify({
        error:
          "'values' must contain only strings, numbers, booleans, " +
          "arrays, nested objects, or rich-text patch values.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const scanned = await scanTemplateUpload(file);
  if (Result.isError(scanned)) {
    return templateUploadRejectionResponse(scanned.error);
  }
  const sourceName = sanitizeFilename(file.name);

  const result = await fillTemplateDocx({
    source: { name: sourceName, fileName: sourceName, file: scanned.value },
    values: parsed,
    scopedDb,
    organizationId,
    thirdPartyOutboundPermit: grantThirdPartyOutboundPermit(),
    // A required, user-entered field left absent or empty must never download
    // as an invented value or a raw `{{marker}}`.
    requiredFields: "enforce",
    ...buildTemplateFillAiWiring({
      organizationId,
      userId,
      safeDb,
      scopedDb,
      feature: "templates.fill",
    }),
  });

  if ("requiredFieldsRejection" in result) {
    return new Response(
      JSON.stringify({
        error: "missing_required_fields",
        missingFields: result.requiredFieldsRejection,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if ("usageRejection" in result) {
    return usageRejectionResponse(result.usageRejection);
  }
  if ("error" in result) {
    return new Response(JSON.stringify({ error: result.error }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // The recorded status is the completion decision over every diagnostic: a
  // failed AI draft, an undecided AI condition or an unresolved clause counts
  // against the fill the same way an unmatched placeholder does.
  const diagnostics = fillDiagnosticsOf(result);

  // Best-effort analytics; don't block the download. The template came with
  // the request and is not stored, so the row has no template and no audit
  // event (there is no resource to audit against).
  scopedDb(
    async (tx) =>
      await recordTemplateFill({
        tx,
        templateId: null,
        organizationId,
        userId,
        format,
        diagnostics,
      }),
  ).catch((error: unknown) => {
    captureError(error, {
      operation: "template_fill_analytics",
      organizationId,
      userId,
    });
  });

  const additionalHeaders = fillDiagnosticHeaders({ diagnostics, format });

  // PDF conversion via Gotenberg
  if (format === "pdf") {
    const scannedOutput = await scanTemplateOutput({
      buffer: new Uint8Array(result.file.bytes),
      fileName: sourceName,
    });
    if (scannedOutput === null) {
      return new Response(
        JSON.stringify({ error: "Template output invalid" }),
        {
          status: 422,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    const pdfResult = await convertToPdf(scannedOutput);
    if (Result.isError(pdfResult)) {
      return new Response(JSON.stringify({ error: "PDF conversion failed" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    const pdfName = DOCX_EXT_RE.test(sourceName)
      ? sourceName.replace(DOCX_EXT_RE, ".pdf")
      : `${sourceName}.pdf`;
    return secureDocumentResponse({
      additionalHeaders,
      body: new Uint8Array(pdfResult.value.buffer),
      // Octet-stream, not application/pdf: see OCTET_STREAM_MIME_TYPE.
      contentType: OCTET_STREAM_MIME_TYPE,
      disposition: "attachment",
      fileName: sanitizeFilename(pdfName),
    });
  }

  return secureDocumentResponse({
    additionalHeaders,
    body: new Uint8Array(result.file.bytes),
    // Octet-stream, not the DOCX mime type: the Eden treaty client
    // text-decodes unrecognized content types, which corrupts the ZIP
    // container (Word then reports unreadable content).
    contentType: OCTET_STREAM_MIME_TYPE,
    disposition: "attachment",
    fileName: sanitizeFilename("filled.docx"),
  });
};

const config = {
  contentDelivery: {
    type: "none",
    reason: "Renders the template uploaded in this request.",
  },
  description:
    "Fill a template with values. 'values' maps each field path to its " +
    'value, e.g. {"tenant.name": "ACME Sp. z o.o.", "signing_date": ' +
    '"2026-06-08"}. Registry lookups, composite fields, formula fields, ' +
    "and AI-fillable fields are resolved automatically; AI-fillable fields " +
    "are drafted when you omit them.",
  permissions: { template: ["use"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  access: "write",
  mcp: { type: "tool", name: "fill_template" },
  transport: {
    type: "file-both",
    input: { field: "file", required: true, mediaTypes: [DOCX_MIME_TYPE] },
    // Octet-stream on the wire regardless of the rendered format; see
    // OCTET_STREAM_MIME_TYPE.
    response: { mediaTypes: [OCTET_STREAM_MIME_TYPE] },
    alternative: {
      type: "partial",
      via: ["templates.fills.create"],
      limitation:
        "the template must already be stored, and the filled document lands in a matter instead of coming back as bytes",
    },
  },
  body: fillBodySchema,
  query: fillQuerySchema,
} satisfies HandlerConfig;

const fillTemplateHandler = createSafeRootHandler(
  config,
  async function* ({ safeDb, scopedDb, session, user, body, query }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await fillHandler({
            safeDb,
            scopedDb,
            organizationId: session.activeOrganizationId,
            userId: user.id,
            body,
            query,
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Internal server error",
            cause,
          }),
      }),
    );
    return Result.ok(result);
  },
);

export default fillTemplateHandler;
