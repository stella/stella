import { Result } from "better-result";
import { t } from "elysia";

import type { SafeDb, ScopedDb } from "@/api/db";
import { templateFills } from "@/api/db/schema";
import { adaptAiFields } from "@/api/handlers/docx/adapt-ai-fields";
import {
  buildAiFieldGenerator,
  buildAiLookupFormatter,
  buildAiOccurrenceAdapter,
} from "@/api/handlers/docx/ai-field-generator";
import { discoverClauseSlots } from "@/api/handlers/docx/discover-clause-slots";
import { createDispatchLookupResolver } from "@/api/handlers/docx/lookup-fields";
import { applyManifestFillSteps } from "@/api/handlers/docx/manifest-fill-steps";
import { fillTemplate } from "@/api/handlers/docx/patch-template";
import { resolveAiFields } from "@/api/handlers/docx/resolve-ai-fields";
import { resolveClauseSlots } from "@/api/handlers/docx/resolve-clause-slots";
import { readManifest } from "@/api/handlers/docx/template-manifest";
import { isTemplateData } from "@/api/handlers/docx/types";
import { convertToPdf } from "@/api/handlers/files/gotenberg";
import { recordTemplateUse } from "@/api/handlers/templates/record-use";
import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { contentDisposition } from "@/api/lib/content-disposition";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getS3 } from "@/api/lib/s3";
import { DOCX_EXT_RE } from "@/api/lib/sanitize-filename";
import { isRecord } from "@/api/lib/type-guards";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

import { containsNull } from "./fill";

const fillByIdBodySchema = t.Object({
  values: t.String(),
});

const fillByIdQuerySchema = t.Object({
  format: t.Optional(t.UnionEnum(["docx", "pdf"])),
});

const fillByIdParamsSchema = t.Object({
  templateId: tSafeId("template"),
});

const PDF_MIME_TYPE = "application/pdf";

type FillByIdProps = {
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  templateId: SafeId<"template">;
  body: { values: string };
  query: { format?: "docx" | "pdf" };
  recordAuditEvent: AuditRecorder;
};

const fillByIdHandler = async function* ({
  safeDb,
  scopedDb,
  organizationId,
  userId,
  templateId,
  body: { values: valuesJson },
  query: { format = "docx" },
  recordAuditEvent,
}: FillByIdProps) {
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

  const s3File = getS3().file(template.s3Key);
  const arrayBuf = await s3File.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);

  // Discover and resolve clause slots ({{@clause:...}})
  const slots = await discoverClauseSlots(buffer);
  if (slots.length > 0) {
    const clausePatches = await resolveClauseSlots(
      templateId,
      slots,
      scopedDb,
      organizationId,
    );
    for (const [key, value] of Object.entries(clausePatches)) {
      parsed[key] = value;
    }
  }

  // Draft AI-fillable fields so the downloaded document matches the preview
  // (fill-preview resolves them too); without this an AI-drafted placeholder
  // shown in the preview would download unresolved.
  let fillBuffer: Buffer = buffer;
  let adaptedPaths: readonly string[] = [];
  const manifest = await readManifest(buffer);

  const hasLookupAiFormat = manifest?.fields.some(
    (field) => field.lookup?.aiFormat,
  );
  const hasAiDraftFields = manifest?.fields.some((field) => field.aiPrompt);
  const hasAiAdaptFields = manifest?.fields.some((field) => field.aiAdapt);
  // Loaded once for lookup formatting and the AI draft/adapt steps below.
  const orgAIConfig =
    manifest && (hasAiDraftFields || hasAiAdaptFields || hasLookupAiFormat)
      ? await loadOrgAIConfig(organizationId)
      : null;

  // Resolve registry lookups, assemble composite (multipart) values,
  // evaluate formula (derived) fields, and check dependent (optionsFrom)
  // selects before any AI step or substitution sees them; a failing step
  // rejects the request naming the field.
  const stepError = await applyManifestFillSteps({
    values: parsed,
    manifest,
    resolveLookup: createDispatchLookupResolver(),
    formatLookupWithAi: buildAiLookupFormatter({ orgAIConfig, organizationId }),
  });
  if (stepError !== null) {
    return Result.err(new HandlerError({ status: 400, message: stepError }));
  }

  if (manifest && (hasAiDraftFields || hasAiAdaptFields)) {
    if (hasAiDraftFields) {
      const aiResolved = await resolveAiFields({
        values: parsed,
        fields: manifest.fields,
        generate: buildAiFieldGenerator({ orgAIConfig, organizationId }),
      });
      for (const [key, value] of Object.entries(aiResolved)) {
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
        adapt: buildAiOccurrenceAdapter({ orgAIConfig, organizationId }),
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
      new Response(new Uint8Array(pdfResult.value.buffer), {
        status: 200,
        headers: {
          "Content-Type": PDF_MIME_TYPE,
          "Content-Disposition": contentDisposition(pdfName),
        },
      }),
    );
  }

  const headers = new Headers({
    "Content-Type": DOCX_MIME_TYPE,
    "Content-Disposition": contentDisposition(baseName),
  });

  if (result.unmatchedPlaceholders.length > 0) {
    headers.set(
      "X-Unmatched-Placeholders",
      result.unmatchedPlaceholders.join(","),
    );
  }
  if (unusedValues.length > 0) {
    headers.set("X-Unused-Values", unusedValues.join(","));
  }
  if (result.structureErrors.length > 0) {
    headers.set("X-Structure-Errors", JSON.stringify(result.structureErrors));
  }

  return Result.ok(
    new Response(new Uint8Array(result.buffer), {
      status: 200,
      headers,
    }),
  );
};

const config = {
  permissions: { template: ["create"] },
  params: fillByIdParamsSchema,
  body: fillByIdBodySchema,
  query: fillByIdQuerySchema,
} satisfies HandlerConfig;

const fillTemplateById = createSafeRootHandler(
  config,
  async function* ({
    safeDb,
    scopedDb,
    session,
    user,
    params,
    body,
    query,
    recordAuditEvent,
  }) {
    return yield* fillByIdHandler({
      safeDb,
      scopedDb,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      templateId: params.templateId,
      body,
      query,
      recordAuditEvent,
    });
  },
);

export default fillTemplateById;
