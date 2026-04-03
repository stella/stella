import { Result } from "better-result";
import { status, t } from "elysia";

import { db } from "@/api/db";
import type { ScopedDb } from "@/api/db";
import { discoverClauseSlots } from "@/api/handlers/docx/discover-clause-slots";
import { extractText } from "@/api/handlers/docx/extract-text";
import { fillTemplate } from "@/api/handlers/docx/patch-template";
import { resolveClauseSlots } from "@/api/handlers/docx/resolve-clause-slots";
import type { TemplateData } from "@/api/handlers/docx/types";
import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { s3 } from "@/api/lib/s3";
import { isRecord } from "@/api/lib/type-guards";

import { containsNull } from "./fill";

export const fillPreviewBodySchema = t.Object({
  values: t.String(),
});

export const fillPreviewParamsSchema = t.Object({
  templateId: tNanoid,
});

type FillPreviewProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  templateId: string;
  body: { values: string };
};

export const fillPreviewHandler = async ({
  scopedDb,
  organizationId,
  templateId,
  body: { values: valuesJson },
}: FillPreviewProps) => {
  const template = await db.query.templates.findFirst({
    where: { id: templateId, organizationId: { eq: organizationId } },
    columns: { s3Key: true },
  });

  if (!template) {
    return status(404, { message: "Template not found" });
  }

  const parseResult = Result.try((): unknown => JSON.parse(valuesJson));
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

  const record = parsed;
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

  // SAFETY: same as fillByIdHandler
  // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
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

const config = {
  permissions: { workspace: ["read"] },
  params: fillPreviewParamsSchema,
  body: fillPreviewBodySchema,
} satisfies HandlerConfig;

const fillTemplatePreview = createRootHandler(
  config,
  async ({ scopedDb, session, params, body }) =>
    await fillPreviewHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      templateId: params.templateId,
      body,
    }),
);

export default fillTemplatePreview;
