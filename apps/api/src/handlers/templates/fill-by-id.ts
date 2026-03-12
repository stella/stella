import { Result } from "better-result";
import { status, t } from "elysia";

import { db } from "@/api/db";
import type { ScopedDb } from "@/api/db";
import { templateFills } from "@/api/db/schema";
import { discoverClauseSlots } from "@/api/handlers/docx/discover-clause-slots";
import { fillTemplate } from "@/api/handlers/docx/patch-template";
import { resolveClauseSlots } from "@/api/handlers/docx/resolve-clause-slots";
import type { TemplateData } from "@/api/handlers/docx/types";
import { convertToPdf } from "@/api/handlers/files/gotenberg";
import type { SafeId } from "@/api/lib/branded-types";
import { contentDisposition } from "@/api/lib/content-disposition";
import { s3 } from "@/api/lib/s3";
import { DOCX_EXT_RE } from "@/api/lib/sanitize-filename";
import { isRecord } from "@/api/lib/type-guards";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

import { containsNull } from "./fill";

export const fillByIdBodySchema = t.Object({
  values: t.String(),
});

export const fillByIdQuerySchema = t.Object({
  format: t.Optional(t.UnionEnum(["docx", "pdf"])),
});

const PDF_MIME_TYPE = "application/pdf";

type FillByIdProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  userId: string;
  templateId: string;
  body: { values: string };
  query: { format?: "docx" | "pdf" };
};

export const fillByIdHandler = async ({
  scopedDb,
  organizationId,
  userId,
  templateId,
  body: { values: valuesJson },
  query: { format = "docx" },
}: FillByIdProps) => {
  const template = await db.query.templates.findFirst({
    where: { id: templateId, organizationId: { eq: organizationId } },
    columns: {
      s3Key: true,
      fileName: true,
    },
  });

  if (!template) {
    return status(404, { message: "Template not found" });
  }

  const parseResult = Result.try(() => JSON.parse(valuesJson) as unknown);
  if (Result.isError(parseResult)) {
    return status(400, {
      message: "Invalid JSON in 'values' field.",
    });
  }

  const parsed = parseResult.value;
  if (!isRecord(parsed)) {
    return status(400, {
      message: "'values' must be a JSON object (not null or array).",
    });
  }

  if (Object.values(parsed).some(containsNull)) {
    return status(400, {
      message: "'values' must not contain null values.",
    });
  }

  const s3File = s3.file(template.s3Key);
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

  // SAFETY: `parsed` is validated as a non-null, non-array object
  // with no null values. `fillTemplate` handles arbitrary value
  // shapes via `isTemplateData` discrimination internally.
  const result = await fillTemplate(buffer, parsed as TemplateData);

  const fillStatus =
    result.unmatchedPlaceholders.length > 0 ? "partial" : "success";

  // Best-effort analytics; don't block the download
  db.insert(templateFills)
    .values({
      organizationId,
      templateId,
      userId,
      format,
      status: fillStatus,
      unmatchedCount: result.unmatchedPlaceholders.length,
      unusedCount: result.unusedValues.length,
      structureErrors:
        result.structureErrors.length > 0 ? result.structureErrors : null,
    })
    // eslint-disable-next-line no-empty
    .catch(() => {});

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
      return status(502, {
        message: "PDF conversion failed",
      });
    }

    const pdfName = DOCX_EXT_RE.test(baseName)
      ? baseName.replace(DOCX_EXT_RE, ".pdf")
      : `${baseName}.pdf`;
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
    "Content-Disposition": contentDisposition(baseName),
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
