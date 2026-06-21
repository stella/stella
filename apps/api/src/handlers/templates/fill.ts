import { Result } from "better-result";
import { t } from "elysia";

import type { SafeDb, ScopedDb } from "@/api/db";
import { templateFills } from "@/api/db/schema";
import { adaptAiFields } from "@/api/handlers/docx/adapt-ai-fields";
import {
  buildAiConditionDecider,
  buildAiFieldGenerator,
  buildAiOccurrenceAdapter,
} from "@/api/handlers/docx/ai-field-generator";
import { documentTextForAiFields } from "@/api/handlers/docx/extract-text";
import { createDispatchLookupResolver } from "@/api/handlers/docx/lookup-fields";
import { applyManifestFillSteps } from "@/api/handlers/docx/manifest-fill-steps";
import { fillTemplate } from "@/api/handlers/docx/patch-template";
import { resolveAiConditions } from "@/api/handlers/docx/resolve-ai-conditions";
import { resolveAiFields } from "@/api/handlers/docx/resolve-ai-fields";
import { readManifest } from "@/api/handlers/docx/template-manifest";
import { isTemplateData, type TemplateData } from "@/api/handlers/docx/types";
import { convertToPdf } from "@/api/handlers/files/gotenberg";
import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
import { hasInstanceProvider } from "@/api/lib/ai-models";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { captureError } from "@/api/lib/analytics";
import { createAIAnalyticsCallbacks } from "@/api/lib/analytics/ai";
import {
  assertUsageAvailableForHandler,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { contentDisposition } from "@/api/lib/content-disposition";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { DOCX_EXT_RE, sanitizeFilename } from "@/api/lib/sanitize-filename";
import { isRecord } from "@/api/lib/type-guards";
import { DOCX_MIME_TYPE, OCTET_STREAM_MIME_TYPE } from "@/api/mime-types";

const fillBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.document }),
  values: t.String(),
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

export const containsNull = (value: unknown): boolean => {
  if (value === null) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(containsNull);
  }
  if (typeof value === "object") {
    return Object.values(value).some(containsNull);
  }
  return false;
};

type TemplateFillUsageArgs = {
  /** Org AI (BYOK) config; null when the org has no usable AI config, in which
   *  case the generators are no-ops and no model call (or quota) occurs. */
  orgAIConfig: OrgAIConfig | null;
  /** Whether the manifest declares any AI-drafted/adapted field. */
  hasAiFields: boolean;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  safeDb: SafeDb;
};

/**
 * Usage preflight for the template-fill routes, gated on a model call actually
 * running (an org AI config plus a manifest AI field). A deterministic fill
 * spends no AI quota, so the static `requiresUsage` config is omitted and this
 * runs in-handler instead. Returns the framework's 402/500 `HandlerError` (the
 * caller returns it as `Result.err`) or `null` to proceed.
 */
export const assertTemplateFillUsage = async ({
  orgAIConfig,
  hasAiFields,
  organizationId,
  userId,
  safeDb,
}: TemplateFillUsageArgs): Promise<HandlerError<402 | 500> | null> => {
  // Skip only when there is no AI field to bill, or no provider could run a
  // model at all. With an instance provider but no org BYOK, the fill still
  // calls the fast model (getModelForRole resolves the instance provider), so
  // the quota check must apply — a null org config is not "no model call". The
  // metering layer prices the instance-provider call (non-BYOK rate).
  if (!hasAiFields || (!orgAIConfig && !hasInstanceProvider())) {
    return null;
  }
  return await assertUsageAvailableForHandler({
    metering: { actionType: "chat", modelRole: "fast" },
    organizationId,
    orgAIConfig,
    workspaceId: null,
    userId,
    safeDb,
  });
};

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

  const buffer = Buffer.from(await file.arrayBuffer());
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

  // Draft any AI-fillable fields (manifest fields with an aiPrompt) before fill,
  // so an AI placeholder like "the scope of this power of attorney" is filled on
  // download just as the chat fill tool fills it. A user-supplied value wins.
  let fillData: TemplateData = parsed;
  let fillBuffer: Buffer = buffer;
  let adaptedPaths: readonly string[] = [];
  const manifest = await readManifest(buffer);

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
    resolveLookup: createDispatchLookupResolver(),
  });
  if (stepError !== null) {
    return new Response(JSON.stringify({ error: stepError }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (manifest && (hasAiDraftFields || hasAiAdaptFields)) {
    const aiAnalytics = createAIAnalyticsCallbacks({
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
        generate: buildAiFieldGenerator({
          orgAIConfig,
          organizationId,
          skillContext: { organizationId, safeDb, userId },
          aiAnalytics,
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
    return new Response(new Uint8Array(pdfResult.value.buffer), {
      status: 200,
      headers: {
        // Octet-stream, not application/pdf: see OCTET_STREAM_MIME_TYPE.
        "Content-Type": OCTET_STREAM_MIME_TYPE,
        "Content-Disposition": contentDisposition(pdfName),
      },
    });
  }

  const headers = new Headers({
    // Octet-stream, not the DOCX mime type: the Eden treaty client
    // text-decodes unrecognized content types, which corrupts the ZIP
    // container (Word then reports unreadable content). See
    // OCTET_STREAM_MIME_TYPE in mime-types.ts.
    "Content-Type": OCTET_STREAM_MIME_TYPE,
    "Content-Disposition": 'attachment; filename="filled.docx"',
  });

  if (result.unmatchedPlaceholders.length > 0) {
    headers.set(
      "X-Unmatched-Placeholders",
      // Headers are ISO-8859-1; field paths carry diacritics (Polish/Czech),
      // so the diagnostic lists travel URI-encoded.
      encodeURIComponent(result.unmatchedPlaceholders.join(",")),
    );
  }
  if (unusedValues.length > 0) {
    headers.set("X-Unused-Values", encodeURIComponent(unusedValues.join(",")));
  }
  if (result.structureErrors.length > 0) {
    headers.set("X-Structure-Errors", JSON.stringify(result.structureErrors));
  }

  return new Response(new Uint8Array(result.buffer), {
    status: 200,
    headers,
  });
};

const config = {
  permissions: { template: ["create"] },
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
