import { status, t } from "elysia";

import type { ScopedDb } from "@/api/db";
import { discoverClauseSlots } from "@/api/handlers/docx/discover-clause-slots";
import { discoverTemplate } from "@/api/handlers/docx/discover-template";
import { extractText } from "@/api/handlers/docx/extract-text";
import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { s3 } from "@/api/lib/s3";

export const previewTemplateParamsSchema = t.Object({
  templateId: tNanoid,
});

type PreviewTemplateProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  templateId: string;
};

export const previewTemplateHandler = async ({
  scopedDb,
  organizationId,
  templateId,
}: PreviewTemplateProps) => {
  const template = await scopedDb((tx) =>
    tx.query.templates.findFirst({
      where: { id: templateId, organizationId: { eq: organizationId } },
      columns: { s3Key: true },
    }),
  );

  if (!template) {
    return status(404, { message: "Template not found" });
  }

  const buffer = Buffer.from(await s3.file(template.s3Key).arrayBuffer());

  const [{ paragraphs, charCount }, { structureErrors }, clauseSlots] =
    await Promise.all([
      extractText(buffer),
      discoverTemplate(buffer),
      discoverClauseSlots(buffer),
    ]);

  // discoverTemplate returns structureError indices relative
  // to each section (body starts at 0, combined headers start
  // at 0, combined footers start at 0). extractText returns
  // global indices: headers first, then body, then footers.
  // Offset each error based on its source.
  const headerCount = paragraphs.filter((p) => p.source === "header").length;
  const bodyCount = paragraphs.filter((p) => p.source === "body").length;

  for (const err of structureErrors) {
    if (err.source === "body") {
      err.paragraphIndex += headerCount;
    } else if (err.source === "footer") {
      err.paragraphIndex += headerCount + bodyCount;
    }
    // header errors: no offset needed (headers come first)
  }

  const slotNames = clauseSlots.map((s) => s.name);

  return {
    paragraphs,
    charCount,
    structureErrors,
    clauseSlots: slotNames,
  };
};

const config = {
  permissions: { workspace: ["read"] },
  params: previewTemplateParamsSchema,
} satisfies HandlerConfig;

const previewTemplate = createRootHandler(
  config,
  async ({ scopedDb, session, params }) =>
    await previewTemplateHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      templateId: params.templateId,
    }),
);

export default previewTemplate;
