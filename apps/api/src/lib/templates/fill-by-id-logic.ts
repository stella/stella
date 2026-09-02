/**
 * `templates.fill-by-id`'s fill logic, factored out of the endpoint module
 * (`handlers/templates/fill-by-id.ts`) so that module can keep to one default
 * `{ config, handler }` export while this generator stays directly testable.
 */

import { Result } from "better-result";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { templateFills } from "@/api/db/schema";
import { isTemplateOutputValid } from "@/api/handlers/templates/validate-template-output";
import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { clauseBodyToRichPatch } from "@/api/lib/clauses/clause-to-patch";
import type { ClauseBody } from "@/api/lib/clauses/types";
import { adaptAiFields } from "@/api/lib/docx/adapt-ai-fields";
import {
  buildAiConditionDecider,
  buildAiFieldGenerator,
  buildAiOccurrenceAdapter,
} from "@/api/lib/docx/ai-field-generator";
import { discoverClauseSlots } from "@/api/lib/docx/discover-clause-slots";
import { documentTextForAiFields } from "@/api/lib/docx/extract-text";
import { createDispatchLookupResolver } from "@/api/lib/docx/lookup-fields";
import { applyManifestFillSteps } from "@/api/lib/docx/manifest-fill-steps";
import { fillTemplate } from "@/api/lib/docx/patch-template";
import { buildIsRegistryEnabledForOrg } from "@/api/lib/docx/registry-org-gate";
import { resolveAiConditions } from "@/api/lib/docx/resolve-ai-conditions";
import { resolveAiFields } from "@/api/lib/docx/resolve-ai-fields";
import { resolveClauseSlots } from "@/api/lib/docx/resolve-clause-slots";
import { readManifest } from "@/api/lib/docx/template-manifest";
import { isTemplateData } from "@/api/lib/docx/types";
import type { RichPatchValue } from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { convertToPdf } from "@/api/lib/files/gotenberg";
import { readS3ArrayBuffer } from "@/api/lib/s3";
import { DOCX_EXT_RE, sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";
import { recordTemplateUse } from "@/api/lib/templates/record-use";
import { containsNull } from "@/api/lib/templates/template-data";
import { assertTemplateFillUsage } from "@/api/lib/templates/template-fill-usage";
import { collectMissingRequiredFields } from "@/api/lib/templates/template-optional-defaults";
import { isRecord } from "@/api/lib/type-guards";
import { DOCX_MIME_TYPE, OCTET_STREAM_MIME_TYPE } from "@/api/mime-types";

export type FillByIdLogicProps = {
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  templateId: SafeId<"template">;
  body: { values: string; clauseOverrides?: Record<string, ClauseBody> };
  query: { format?: "docx" | "pdf" };
  recordAuditEvent: AuditRecorder;
};

type ResolveClausePatchesArgs = {
  buffer: Buffer;
  templateId: SafeId<"template">;
  clauseOverrides: Record<string, ClauseBody> | undefined;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
};

/** Resolve the template's clause slots to rich patches, with any per-fill
 *  override taking precedence over the linked clause body. */
const resolveClausePatches = async ({
  buffer,
  templateId,
  clauseOverrides,
  scopedDb,
  organizationId,
}: ResolveClausePatchesArgs): Promise<Record<string, RichPatchValue>> => {
  const slots = await discoverClauseSlots(buffer);
  if (slots.length === 0) {
    return {};
  }
  const patches = await resolveClauseSlots(
    templateId,
    slots,
    scopedDb,
    organizationId,
  );
  if (clauseOverrides) {
    const slotKeys = new Set(slots.map((slot) => slot.patchKey));
    for (const [key, overrideBody] of Object.entries(clauseOverrides)) {
      if (slotKeys.has(key)) {
        patches[key] = clauseBodyToRichPatch(overrideBody);
      }
    }
  }
  return patches;
};

/** `templates.fill-by-id`'s fill logic. Mirrors `fillHandler` (the raw-upload
 *  route) with a stored template's clause-slot resolution, AI drafting, and
 *  audit/use bookkeeping layered on top.
 *
 * @yields safeDb/scopedDb errors out to the parent safe-handler. */
export const fillByIdLogic = async function* ({
  safeDb,
  scopedDb,
  organizationId,
  userId,
  templateId,
  body: { values: valuesJson, clauseOverrides },
  query: { format = "docx" },
  recordAuditEvent,
}: FillByIdLogicProps) {
  const template = yield* Result.await(
    safeDb((tx) =>
      tx.query.templates.findFirst({
        where: {
          id: { eq: templateId },
          organizationId: { eq: organizationId },
        },
        columns: {
          s3Key: true,
          fileName: true,
          languages: true,
        },
      }),
    ),
  );

  if (!template) {
    return Result.err(
      new HandlerError({ status: 404, message: "Template not found" }),
    );
  }

  const parseResult = Result.try((): unknown => JSON.parse(valuesJson));
  if (Result.isError(parseResult)) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Invalid JSON in 'values' field.",
      }),
    );
  }

  const parsed = parseResult.value;
  if (!isRecord(parsed)) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "'values' must be a JSON object (not null or array).",
      }),
    );
  }

  if (Object.values(parsed).some(containsNull)) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "'values' must not contain null values.",
      }),
    );
  }

  const arrayBuf = await readS3ArrayBuffer(template.s3Key);
  const buffer = Buffer.from(arrayBuf);

  // Discover/resolve clause slots ({{@clause:...}}) and apply per-fill overrides.
  const clausePatches = await resolveClausePatches({
    buffer,
    templateId,
    clauseOverrides,
    scopedDb,
    organizationId,
  });
  for (const [key, value] of Object.entries(clausePatches)) {
    parsed[key] = value;
  }

  // Draft AI-fillable fields so the downloaded document matches the preview
  // (fill-preview resolves them too); without this an AI-drafted placeholder
  // shown in the preview would download unresolved.
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
      values: parsed,
    });
    if (missingRequiredFields.length > 0) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Missing required template values: ${missingRequiredFields
            .map((field) => field.label ?? field.path)
            .join(", ")}`,
          requiredFields: missingRequiredFields,
        }),
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

  const usageRejection = await assertTemplateFillUsage({
    orgAIConfig,
    hasAiFields: Boolean(hasAiDraftFields) || Boolean(hasAiAdaptFields),
    organizationId,
    userId,
    safeDb,
  });
  if (usageRejection !== null) {
    return Result.err(usageRejection);
  }

  // Resolve registry lookups, assemble composite (multipart) values,
  // evaluate formula (derived) fields, and check dependent (optionsFrom)
  // selects before any AI step or substitution sees them; a failing step
  // rejects the request naming the field.
  const stepError = await applyManifestFillSteps({
    values: parsed,
    manifest,
    resolveLookup: createDispatchLookupResolver({
      isRegistryEnabledForOrg: await buildIsRegistryEnabledForOrg({
        organizationId,
        scopedDb,
      }),
    }),
  });
  if (stepError !== null) {
    return Result.err(new HandlerError({ status: 400, message: stepError }));
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
      const aiResolved = await resolveAiFields({
        values: parsed,
        fields: manifest.fields,
        documentText,
        // Root-scoped route (template selected by id, no matter binding), so
        // there is no workspace scope to redact tenant ids against.
        generate: buildAiFieldGenerator({
          orgAIConfig,
          organizationId,
          skillContext: { organizationId, safeDb, userId },
          aiAnalytics,
          tenantWorkspaceIds: [],
        }),
      });
      // Decide AI-decided boolean conditions (a boolean field with an aiPrompt)
      // so the downloaded document matches the preview.
      const aiDecided = await resolveAiConditions({
        values: aiResolved,
        fields: manifest.fields,
        decide: buildAiConditionDecider({
          orgAIConfig,
          organizationId,
          skillContext: { organizationId, safeDb, userId },
          aiAnalytics,
          tenantWorkspaceIds: [],
        }),
      });
      for (const [key, value] of Object.entries(aiDecided)) {
        parsed[key] = value;
      }
    }
    if (hasAiAdaptFields) {
      // Rewrite each aiAdapt marker occurrence to fit its surrounding text;
      // the stub stays in `parsed` so uncovered occurrences still get the
      // plain global substitution below.
      const adapted = await adaptAiFields({
        buffer,
        fields: manifest.fields,
        values: parsed,
        adapt: buildAiOccurrenceAdapter({
          orgAIConfig,
          organizationId,
          documentLanguages: template.languages,
          skillContext: { organizationId, safeDb, userId },
          aiAnalytics,
          tenantWorkspaceIds: [],
        }),
      });
      fillBuffer = adapted.buffer;
      adaptedPaths = adapted.adaptedPaths;
    }
  }

  if (!isTemplateData(parsed)) {
    return Result.err(
      new HandlerError({
        status: 400,
        message:
          "'values' must contain only strings, numbers, booleans, " +
          "arrays, nested objects, or rich-text patch values.",
      }),
    );
  }

  const result = await fillTemplate(fillBuffer, parsed);
  // Adapted stubs no longer match a marker (each occurrence was already
  // substituted), so they are not "unused" in any user-meaningful sense.
  const unusedValues = result.unusedValues.filter(
    (name) => !adaptedPaths.includes(name),
  );

  const fillStatus =
    result.unmatchedPlaceholders.length > 0 ? "partial" : "success";

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

  const baseName = template.fileName;

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
    return Result.ok(
      secureDocumentResponse({
        body: new Uint8Array(pdfResult.value.buffer),
        // Octet-stream, not application/pdf: see OCTET_STREAM_MIME_TYPE.
        contentType: OCTET_STREAM_MIME_TYPE,
        disposition: "attachment",
        fileName: sanitizeFilename(pdfName),
      }),
    );
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

  return Result.ok(
    secureDocumentResponse({
      additionalHeaders,
      body: new Uint8Array(result.buffer),
      // Octet-stream, not the DOCX mime type: the Eden treaty client
      // text-decodes unrecognized content types, which corrupts the ZIP
      // container (Word then reports unreadable content).
      contentType: OCTET_STREAM_MIME_TYPE,
      disposition: "attachment",
      fileName: sanitizeFilename(baseName),
    }),
  );
};
