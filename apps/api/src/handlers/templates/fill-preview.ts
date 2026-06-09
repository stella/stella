import { Result } from "better-result";
import { t } from "elysia";

import type { SafeDb, ScopedDb } from "@/api/db";
import { adaptAiFields } from "@/api/handlers/docx/adapt-ai-fields";
import {
  buildAiFieldGenerator,
  buildAiOccurrenceAdapter,
} from "@/api/handlers/docx/ai-field-generator";
import { applyCompositeFields } from "@/api/handlers/docx/composite-fields";
import { checkDependentFields } from "@/api/handlers/docx/dependent-fields";
import { discoverClauseSlots } from "@/api/handlers/docx/discover-clause-slots";
import { extractText } from "@/api/handlers/docx/extract-text";
import { fillTemplate } from "@/api/handlers/docx/patch-template";
import { resolveAiFields } from "@/api/handlers/docx/resolve-ai-fields";
import { resolveClauseSlots } from "@/api/handlers/docx/resolve-clause-slots";
import { readManifest } from "@/api/handlers/docx/template-manifest";
import { isTemplateData } from "@/api/handlers/docx/types";
import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getS3 } from "@/api/lib/s3";
import { isRecord } from "@/api/lib/type-guards";

import { containsNull } from "./fill";

const fillPreviewBodySchema = t.Object({
  values: t.String(),
});

const fillPreviewParamsSchema = t.Object({
  templateId: tSafeId("template"),
});

type FillPreviewProps = {
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
  body: { values: string };
};

const fillPreviewHandler = async function* ({
  safeDb,
  scopedDb,
  organizationId,
  templateId,
  body: { values: valuesJson },
}: FillPreviewProps) {
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

  const s3File = getS3().file(template.s3Key);
  const arrayBuf = await s3File.arrayBuffer();
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

  // Assemble composite (multipart) field values into their final strings
  // before any AI step or substitution sees them.
  const compositeError = applyCompositeFields(record, manifest);
  if (compositeError !== null) {
    return Result.err(
      new HandlerError({ status: 400, message: compositeError }),
    );
  }

  // Dependent (optionsFrom) selects must hold one of the source field's
  // submitted values; reject before any AI step or substitution.
  const dependentError = checkDependentFields(record, manifest);
  if (dependentError !== null) {
    return Result.err(
      new HandlerError({ status: 400, message: dependentError }),
    );
  }

  const hasAiDraftFields = manifest?.fields.some((field) => field.aiPrompt);
  const hasAiAdaptFields = manifest?.fields.some((field) => field.aiAdapt);
  if (manifest && (hasAiDraftFields || hasAiAdaptFields)) {
    const orgAIConfig = await loadOrgAIConfig(organizationId);
    if (hasAiDraftFields) {
      const aiResolved = await resolveAiFields({
        values: record,
        fields: manifest.fields,
        generate: buildAiFieldGenerator({ orgAIConfig, organizationId }),
      });
      for (const [key, value] of Object.entries(aiResolved)) {
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
        adapt: buildAiOccurrenceAdapter({ orgAIConfig, organizationId }),
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

const config = {
  permissions: { workspace: ["read"] },
  params: fillPreviewParamsSchema,
  body: fillPreviewBodySchema,
} satisfies HandlerConfig;

const fillTemplatePreview = createSafeRootHandler(
  config,
  async function* ({ safeDb, scopedDb, session, params, body }) {
    return yield* fillPreviewHandler({
      safeDb,
      scopedDb,
      organizationId: session.activeOrganizationId,
      templateId: params.templateId,
      body,
    });
  },
);

export default fillTemplatePreview;
