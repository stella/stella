import { Result } from "better-result";
import { t } from "elysia";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { templateFills } from "@/api/db/schema";
import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { adaptAiFields } from "@/api/lib/docx/adapt-ai-fields";
import {
  buildAiConditionDecider,
  buildAiFieldGenerator,
  buildAiOccurrenceAdapter,
} from "@/api/lib/docx/ai-field-generator";
import { documentTextForAiFields } from "@/api/lib/docx/extract-text";
import { createDispatchLookupResolver } from "@/api/lib/docx/lookup-fields";
import { applyManifestFillSteps } from "@/api/lib/docx/manifest-fill-steps";
import { fillTemplate } from "@/api/lib/docx/patch-template";
import { buildIsRegistryEnabledForOrg } from "@/api/lib/docx/registry-org-gate";
import { resolveAiConditions } from "@/api/lib/docx/resolve-ai-conditions";
import { resolveAiFields } from "@/api/lib/docx/resolve-ai-fields";
import { readManifest } from "@/api/lib/docx/template-manifest";
import { isTemplateData, type TemplateData } from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { convertToPdf } from "@/api/lib/files/gotenberg";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { DOCX_EXT_RE, sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";
import { containsNull } from "@/api/lib/templates/template-data";
import { assertTemplateFillUsage } from "@/api/lib/templates/template-fill-usage";
import { collectMissingRequiredFields } from "@/api/lib/templates/template-optional-defaults";
import { isTemplateOutputValid } from "@/api/lib/templates/validate-template-output";
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

/** Serialize a usage-limit `HandlerError` to the same JSON body the framework
 *  preflight returns (message plus the 402 usage detail), for this route's
 *  raw-Response download path. */
const usageRejectionResponse = (error: HandlerError<402 | 500>): Response =>
  new Response(
    JSON.stringify({
      message: error.message,
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

  const buffer = Buffer.from(await file.arrayBuffer());

  // Draft any AI-fillable fields (manifest fields with an aiPrompt) before fill,
  // so an AI placeholder like "the scope of this power of attorney" is filled on
  // download just as the chat fill tool fills it. A user-supplied value wins.
  let fillData: TemplateData = parsed;
  let fillBuffer: Buffer = buffer;
  let adaptedPaths: readonly string[] = [];
  const manifest = await readManifest(buffer);

  // Reject before any AI/registry work runs: a required, user-entered field
  // left absent or empty must never download as an invented value or a raw
  // `{{marker}}`. This route always enforces the full contract (unlike
  // fill-preview, whose live typing preview legitimately allows partial
  // values).
  if (manifest) {
    const missingRequiredFields = collectMissingRequiredFields({
      fields: manifest.fields,
      policy: "enforce",
      values: fillData,
    });
    if (missingRequiredFields.length > 0) {
      return new Response(
        JSON.stringify({
          error: "missing_required_fields",
          missingFields: missingRequiredFields,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  const hasAiDraftFields = manifest?.fields.some((field) => field.aiPrompt);
  const hasAiAdaptFields = manifest?.fields.some((field) => field.aiAdapt);
  // Loaded once for the AI draft/adapt steps below.
  const orgAIConfig =
    manifest && (hasAiDraftFields || hasAiAdaptFields)
      ? await loadOrgAIConfig(organizationId)
      : null;

  // This download route streams its own Response, so a usage rejection is
  // serialized to the same body the framework preflight emits (message plus
  // usage detail) here.
  const usageRejection = await assertTemplateFillUsage({
    orgAIConfig,
    hasAiFields: Boolean(hasAiDraftFields) || Boolean(hasAiAdaptFields),
    organizationId,
    userId,
    safeDb,
  });
  if (usageRejection !== null) {
    return usageRejectionResponse(usageRejection);
  }

  // Resolve registry lookups, assemble composite (multipart) values,
  // evaluate formula (derived) fields, and check dependent (optionsFrom)
  // selects before any AI step or substitution sees them (in place: a
  // resolved value is a plain string, so the data stays valid TemplateData);
  // a failing step rejects naming the field.
  const stepError = await applyManifestFillSteps({
    values: fillData,
    manifest,
    resolveLookup: createDispatchLookupResolver({
      isRegistryEnabledForOrg: await buildIsRegistryEnabledForOrg({
        organizationId,
        scopedDb,
      }),
    }),
  });
  if (stepError !== null) {
    return new Response(JSON.stringify({ error: stepError }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (manifest && (hasAiDraftFields || hasAiAdaptFields)) {
    const aiAnalytics = createTanStackAIAnalyticsCallbacks({
      usageMetering: {
        actionType: "chat",
        organizationId,
        safeDb,
        serviceTier: "standard",
        userId,
        workspaceId: null,
      },
      feature: "templates.fill",
      modelRole: "fast",
      orgAIConfig,
      properties: { organization_id: organizationId },
      traceId: Bun.randomUUIDv7(),
    });
    if (hasAiDraftFields) {
      const documentText = await documentTextForAiFields(
        new Uint8Array(buffer),
        manifest.fields,
      );
      const resolved = await resolveAiFields({
        values: parsed,
        fields: manifest.fields,
        documentText,
        // This route fills a raw uploaded DOCX via a root handler, so there is
        // no workspace/matter scope to redact tenant ids against.
        generate: buildAiFieldGenerator({
          orgAIConfig,
          organizationId,
          skillContext: { organizationId, safeDb, userId },
          aiAnalytics,
          tenantWorkspaceIds: [],
        }),
      });
      // Decide AI-decided boolean conditions (a boolean field with an aiPrompt)
      // alongside the string drafts; resolveAiFields skips boolean fields.
      const decided = await resolveAiConditions({
        values: resolved,
        fields: manifest.fields,
        decide: buildAiConditionDecider({
          orgAIConfig,
          organizationId,
          skillContext: { organizationId, safeDb, userId },
          aiAnalytics,
          tenantWorkspaceIds: [],
        }),
      });
      if (isTemplateData(decided)) {
        fillData = decided;
      }
    }
    if (hasAiAdaptFields) {
      // Rewrite each aiAdapt marker occurrence to fit its surrounding text
      // (declension); the stub stays in fillData so uncovered occurrences
      // still get the plain global substitution below.
      const adapted = await adaptAiFields({
        buffer,
        fields: manifest.fields,
        values: fillData,
        adapt: buildAiOccurrenceAdapter({
          orgAIConfig,
          organizationId,
          skillContext: { organizationId, safeDb, userId },
          aiAnalytics,
          tenantWorkspaceIds: [],
        }),
      });
      fillBuffer = adapted.buffer;
      adaptedPaths = adapted.adaptedPaths;
    }
  }

  const result = await fillTemplate(fillBuffer, fillData);
  // Adapted stubs no longer match a marker (each occurrence was already
  // substituted), so they are not "unused" in any user-meaningful sense.
  const unusedValues = result.unusedValues.filter(
    (name) => !adaptedPaths.includes(name),
  );

  const fillStatus =
    result.unmatchedPlaceholders.length > 0 ? "partial" : "success";

  // Best-effort analytics; don't block the download.
  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive that the require-audit-on-mutation rule scans for inside this arrow's body range
  scopedDb((tx) => {
    // audit: skip — anonymous template-fill analytics counter; the input
    // DOCX is supplied directly in the request body and is not persisted
    // as a template resource, so there is no resourceId to audit against.
    return tx.insert(templateFills).values({
      organizationId,
      userId,
      format,
      status: fillStatus,
      unmatchedCount: result.unmatchedPlaceholders.length,
      unusedCount: unusedValues.length,
      structureErrors:
        result.structureErrors.length > 0 ? result.structureErrors : null,
    });
  }).catch((error: unknown) => {
    captureError(error, {
      operation: "template_fill_analytics",
      organizationId,
      userId,
    });
  });

  // PDF conversion via Gotenberg
  if (format === "pdf") {
    const docxBytes = new Uint8Array(result.buffer);
    if (
      !(await isTemplateOutputValid({
        buffer: docxBytes,
        fileName: sanitizeFilename(file.name),
      }))
    ) {
      return new Response(
        JSON.stringify({ error: "Template output invalid" }),
        {
          status: 422,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    const pdfResult = await convertToPdf(
      docxBytes.buffer.slice(
        docxBytes.byteOffset,
        docxBytes.byteOffset + docxBytes.byteLength,
      ),
      sanitizeFilename(file.name),
      DOCX_MIME_TYPE,
    );
    if (Result.isError(pdfResult)) {
      return new Response(JSON.stringify({ error: "PDF conversion failed" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    const sanitized = sanitizeFilename(file.name);
    const pdfName = DOCX_EXT_RE.test(sanitized)
      ? sanitized.replace(DOCX_EXT_RE, ".pdf")
      : `${sanitized}.pdf`;
    return secureDocumentResponse({
      body: new Uint8Array(pdfResult.value.buffer),
      // Octet-stream, not application/pdf: see OCTET_STREAM_MIME_TYPE.
      contentType: OCTET_STREAM_MIME_TYPE,
      disposition: "attachment",
      fileName: sanitizeFilename(pdfName),
    });
  }

  const additionalHeaders = new Headers();

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

  return secureDocumentResponse({
    additionalHeaders,
    body: new Uint8Array(result.buffer),
    // Octet-stream, not the DOCX mime type: the Eden treaty client
    // text-decodes unrecognized content types, which corrupts the ZIP
    // container (Word then reports unreadable content).
    contentType: OCTET_STREAM_MIME_TYPE,
    disposition: "attachment",
    fileName: sanitizeFilename("filled.docx"),
  });
};

const config = {
  description:
    "Fill a template with values. 'values' maps each field path to its " +
    'value, e.g. {"tenant.name": "ACME Sp. z o.o.", "signing_date": ' +
    '"2026-06-08"}. Registry lookups, composite fields, formula fields, ' +
    "and AI-fillable fields are resolved automatically; AI-fillable fields " +
    "are drafted when you omit them.",
  permissions: { template: ["use"] },
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
      via: ["templates.fill-to-workspace"],
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
