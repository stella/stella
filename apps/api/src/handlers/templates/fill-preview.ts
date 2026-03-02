import { Result } from "better-result";
import { status, t } from "elysia";

import { db } from "@/api/db";
import { discoverClauseSlots } from "@/api/handlers/docx/discover-clause-slots";
import { extractText } from "@/api/handlers/docx/extract-text";
import { fillTemplate } from "@/api/handlers/docx/patch-template";
import { resolveClauseSlots } from "@/api/handlers/docx/resolve-clause-slots";
import type { TemplateData } from "@/api/handlers/docx/types";
import type { SafeId } from "@/api/lib/branded-types";
import { s3 } from "@/api/lib/s3";
import { containsNull } from "./fill";

export const fillPreviewBodySchema = t.Object({
  values: t.String(),
});

type FillPreviewProps = {
  organizationId: SafeId<"organization">;
  templateId: string;
  body: { values: string };
};

export const fillPreviewHandler = async ({
  organizationId,
  templateId,
  body: { values: valuesJson },
}: FillPreviewProps) => {
  const template = await db.query.templates.findFirst({
    where: { id: templateId, organizationId },
    columns: { s3Key: true },
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

  // Resolve clause slots before filling
  const slots = await discoverClauseSlots(buffer);
  if (slots.length > 0) {
    const clausePatches = await resolveClauseSlots(templateId, slots);
    for (const [key, value] of Object.entries(clausePatches)) {
      record[key] = value;
    }
  }

  // SAFETY: same as fillByIdHandler
  const result = await fillTemplate(buffer, record as TemplateData);

  // Extract text from the filled document
  const { paragraphs, charCount } = await extractText(result.buffer);

  return {
    paragraphs,
    charCount,
    unmatchedPlaceholders: result.unmatchedPlaceholders,
    unusedValues: result.unusedValues,
    structureErrors: result.structureErrors,
  };
};
