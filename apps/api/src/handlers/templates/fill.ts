import { Result } from "better-result";
import { t } from "elysia";

import type { ScopedDb } from "@/api/db";
import { templateFills } from "@/api/db/schema";
import { fillTemplate } from "@/api/handlers/docx/patch-template";
import type { TemplateData } from "@/api/handlers/docx/types";
import { convertToPdf } from "@/api/handlers/files/gotenberg";
import type { SafeId } from "@/api/lib/branded-types";
import { contentDisposition } from "@/api/lib/content-disposition";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { DOCX_EXT_RE, sanitizeFilename } from "@/api/lib/sanitize-filename";
import { isRecord } from "@/api/lib/type-guards";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

export const fillBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.document }),
  values: t.String(),
});

export const fillQuerySchema = t.Object({
  format: t.Optional(t.UnionEnum(["docx", "pdf"])),
});

const PDF_MIME_TYPE = "application/pdf";

type FillProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  userId: string;
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

  const parseResult = Result.try(() => JSON.parse(valuesJson) as unknown);
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
  // SAFETY: `parsed` is validated as a non-null, non-array object
  // with no null values. `fillTemplate` handles arbitrary value
  // shapes via `isTemplateData` discrimination internally.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const result = await fillTemplate(buffer, parsed as TemplateData);

  const fillStatus =
    result.unmatchedPlaceholders.length > 0 ? "partial" : "success";

  // Best-effort analytics; don't block the download
  scopedDb((tx) =>
    tx.insert(templateFills).values({
      organizationId,
      userId,
      format,
      status: fillStatus,
      unmatchedCount: result.unmatchedPlaceholders.length,
      unusedCount: result.unusedValues.length,
      structureErrors:
        result.structureErrors.length > 0 ? result.structureErrors : null,
    }),
  )
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
  if (result.unusedValues.length > 0) {
    headers.set("X-Unused-Values", result.unusedValues.join(","));
  }
  if (result.structureErrors.length > 0) {
    headers.set("X-Structure-Errors", JSON.stringify(result.structureErrors));
  }

  return new Response(new Uint8Array(result.buffer), {
    status: 200,
    headers,
  });
};
