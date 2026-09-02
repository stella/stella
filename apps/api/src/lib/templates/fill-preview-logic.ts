/**
 * `templates.fill-preview`'s fill logic, factored out of the endpoint module
 * (`handlers/templates/fill-preview.ts`) so that module can keep to one
 * default `{ config, handler }` export while this generator stays directly
 * testable.
 */

import { Result } from "better-result";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import { adaptAiFields } from "@/api/lib/docx/adapt-ai-fields";
import {
  buildAiConditionDecider,
  buildAiFieldGenerator,
  buildAiOccurrenceAdapter,
} from "@/api/lib/docx/ai-field-generator";
import { discoverClauseSlots } from "@/api/lib/docx/discover-clause-slots";
import {
  documentTextForAiFields,
  extractText,
} from "@/api/lib/docx/extract-text";
import { createDispatchLookupResolver } from "@/api/lib/docx/lookup-fields";
import { applyManifestFillSteps } from "@/api/lib/docx/manifest-fill-steps";
import { fillTemplate } from "@/api/lib/docx/patch-template";
import { buildIsRegistryEnabledForOrg } from "@/api/lib/docx/registry-org-gate";
import { resolveAiConditions } from "@/api/lib/docx/resolve-ai-conditions";
import { resolveAiFields } from "@/api/lib/docx/resolve-ai-fields";
import { resolveClauseSlots } from "@/api/lib/docx/resolve-clause-slots";
import { readManifest } from "@/api/lib/docx/template-manifest";
import { isTemplateData } from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readS3ArrayBuffer } from "@/api/lib/s3";
import { containsNull } from "@/api/lib/templates/template-data";
import { assertTemplateFillUsage } from "@/api/lib/templates/template-fill-usage";
import { collectMissingRequiredFields } from "@/api/lib/templates/template-optional-defaults";
import { isRecord } from "@/api/lib/type-guards";

export type FillPreviewLogicProps = {
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  templateId: SafeId<"template">;
  body: { values: string };
};

/** `templates.fill-preview`'s fill logic: the same pipeline as
 *  `fillByIdLogic`, minus the download/PDF/audit steps, returning the
 *  rendered paragraphs and diagnostics for a live preview instead.
 *
 * @yields safeDb errors out to the parent safe-handler. */
export const fillPreviewLogic = async function* ({
  safeDb,
  scopedDb,
  organizationId,
  userId,
  templateId,
  body: { values: valuesJson },
}: FillPreviewLogicProps) {
  const template = yield* Result.await(
    safeDb((tx) =>
      tx.query.templates.findFirst({
        where: {
          id: { eq: templateId },
          organizationId: { eq: organizationId },
        },
        columns: { s3Key: true },
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

  const record = parsed;
  if (Object.values(record).some(containsNull)) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "'values' must not contain null values.",
      }),
    );
  }

  const arrayBuf = await readS3ArrayBuffer(template.s3Key);
  const buffer = Buffer.from(arrayBuf);

  // Resolve clause slots before filling
  const slots = await discoverClauseSlots(buffer);
  if (slots.length > 0) {
    const clausePatches = await resolveClauseSlots(
      templateId,
      slots,
      scopedDb,
      organizationId,
    );
    for (const [key, value] of Object.entries(clausePatches)) {
      record[key] = value;
    }
  }

  // Draft AI-fillable fields so the preview reflects what download produces.
  let fillBuffer: Buffer = buffer;
  let adaptedPaths: readonly string[] = [];
  const manifest = await readManifest(buffer);

  // Live preview: the values are typically still in progress (the person is
  // mid-typing in the fill form), so partial values are explicitly allowed
  // here — the one deliberate exception to the required-fields gate every
  // other fill route (download, chat/MCP tool, workspace persistence)
  // enforces. Named at the call site (`"allow-partial"`) rather than simply
  // never calling the gate, so the exception stays visible and this route
  // keeps tracking the gate's contract if it ever grows beyond a no-op for
  // that policy.
  if (manifest) {
    const missingRequiredFields = collectMissingRequiredFields({
      fields: manifest.fields,
      policy: "allow-partial",
      values: record,
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
    values: record,
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
      feature: "templates.fill_preview",
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
        values: record,
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
      // so the preview reflects which {{#if field_path}} blocks resolve.
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
        record[key] = value;
      }
    }
    if (hasAiAdaptFields) {
      // Rewrite each aiAdapt marker occurrence to fit its surrounding text;
      // the stub stays in `record` so uncovered occurrences still get the
      // plain global substitution below.
      const adapted = await adaptAiFields({
        buffer,
        fields: manifest.fields,
        values: record,
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

  if (!isTemplateData(record)) {
    return Result.err(
      new HandlerError({
        status: 400,
        message:
          "'values' must contain only strings, numbers, booleans, " +
          "arrays, nested objects, or rich-text patch values.",
      }),
    );
  }

  const result = await fillTemplate(fillBuffer, record);

  // Extract text from the filled document
  const { paragraphs, charCount } = await extractText(result.buffer);

  return Result.ok({
    paragraphs,
    charCount,
    unmatchedPlaceholders: result.unmatchedPlaceholders,
    // Adapted stubs no longer match a marker (each occurrence was already
    // substituted), so they are not "unused" in any user-meaningful sense.
    unusedValues: result.unusedValues.filter(
      (name) => !adaptedPaths.includes(name),
    ),
    structureErrors: result.structureErrors,
  });
};
