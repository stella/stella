import { Result } from "better-result";
import { t } from "elysia";

import type { ScopedDb } from "@/api/db";
import { templateFills } from "@/api/db/schema";
import { adaptAiFields } from "@/api/handlers/docx/adapt-ai-fields";
import {
  buildAiFieldGenerator,
  buildAiLookupFormatter,
  buildAiOccurrenceAdapter,
} from "@/api/handlers/docx/ai-field-generator";
import { createDispatchLookupResolver } from "@/api/handlers/docx/lookup-fields";
import { applyManifestFillSteps } from "@/api/handlers/docx/manifest-fill-steps";
import { fillTemplate } from "@/api/handlers/docx/patch-template";
import { resolveAiFields } from "@/api/handlers/docx/resolve-ai-fields";
import { readManifest } from "@/api/handlers/docx/template-manifest";
import { isTemplateData, type TemplateData } from "@/api/handlers/docx/types";
import { convertToPdf } from "@/api/handlers/files/gotenberg";
import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { contentDisposition } from "@/api/lib/content-disposition";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { DOCX_EXT_RE, sanitizeFilename } from "@/api/lib/sanitize-filename";
import { isRecord } from "@/api/lib/type-guards";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const fillBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.document }),
  values: t.String(),
});

const fillQuerySchema = t.Object({
  format: t.Optional(t.UnionEnum(["docx", "pdf"])),
});

const PDF_MIME_TYPE = "application/pdf";

type FillProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  body: { file: File; values: string };
  query: { format?: "docx" | "pdf" };
};

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

export const fillHandler = async ({
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

  // Resolve registry lookups, assemble composite (multipart) values, and
  // check dependent (optionsFrom) selects before any AI step or substitution
  // sees them (in place: a resolved value is a plain string, so the data
  // stays valid TemplateData); a failing step rejects naming the field.
  const stepError = await applyManifestFillSteps({
    values: fillData,
    manifest,
    resolveLookup: createDispatchLookupResolver(),
    formatLookupWithAi: buildAiLookupFormatter({ orgAIConfig, organizationId }),
  });
  if (stepError !== null) {
    return new Response(JSON.stringify({ error: stepError }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (manifest && (hasAiDraftFields || hasAiAdaptFields)) {
    if (hasAiDraftFields) {
      const resolved = await resolveAiFields({
        values: parsed,
        fields: manifest.fields,
        generate: buildAiFieldGenerator({ orgAIConfig, organizationId }),
      });
      if (isTemplateData(resolved)) {
        fillData = resolved;
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
        adapt: buildAiOccurrenceAdapter({ orgAIConfig, organizationId }),
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
  })
    // TODO: fix this
    // oxlint-disable-next-line no-empty-function
    .catch(() => {});

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
        "Content-Type": PDF_MIME_TYPE,
        "Content-Disposition": contentDisposition(pdfName),
      },
    });
  }

  const headers = new Headers({
    "Content-Type": DOCX_MIME_TYPE,
    "Content-Disposition": 'attachment; filename="filled.docx"',
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
  async function* ({ scopedDb, session, user, body, query }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await fillHandler({
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
