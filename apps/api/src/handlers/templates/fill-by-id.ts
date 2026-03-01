import { Result } from "better-result";
import { status, t } from "elysia";

import { db } from "@/api/db";
import { DOCX_MIME_TYPE } from "@/api/handlers/docx/constants";
import { fillTemplate } from "@/api/handlers/docx/patch-template";
import type { TemplateData } from "@/api/handlers/docx/types";
import type { SafeId } from "@/api/lib/branded-types";
import { s3 } from "@/api/lib/s3";
import { containsNull } from "./fill";

/** Strip characters that could inject into Content-Disposition. */
const sanitizeFilename = (name: string) => name.replace(/["\\<>\r\n]/g, "_");

export const fillByIdBodySchema = t.Object({
  values: t.String(),
});

type FillByIdProps = {
  organizationId: SafeId<"organization">;
  templateId: string;
  body: { values: string };
};

export const fillByIdHandler = async ({
  organizationId,
  templateId,
  body: { values: valuesJson },
}: FillByIdProps) => {
  const template = await db.query.templates.findFirst({
    where: { id: templateId, organizationId },
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return status(400, {
      message: "'values' must be a JSON object (not null or array).",
    });
  }

  // SAFETY: null, array, and non-object types are excluded
  // by the guards above; the only remaining shape is an object.
  const record = parsed as Record<string, unknown>;
  if (Object.values(record).some(containsNull)) {
    return status(400, {
      message: "'values' must not contain null values.",
    });
  }

  const s3File = s3.file(template.s3Key);
  const arrayBuf = await s3File.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);

  // SAFETY: `parsed` is validated as a non-null, non-array object
  // with no null values. `fillTemplate` handles arbitrary value
  // shapes via `isTemplateData` discrimination internally.
  const result = await fillTemplate(buffer, record as TemplateData);

  const headers = new Headers({
    "Content-Type": DOCX_MIME_TYPE,
    "Content-Disposition": `attachment; filename="${sanitizeFilename(template.fileName)}"`,
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
