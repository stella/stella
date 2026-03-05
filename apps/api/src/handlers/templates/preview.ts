import { status } from "elysia";

import { db } from "@/api/db";
import { discoverClauseSlots } from "@/api/handlers/docx/discover-clause-slots";
import { discoverTemplate } from "@/api/handlers/docx/discover-template";
import { extractText } from "@/api/handlers/docx/extract-text";
import type { SafeId } from "@/api/lib/branded-types";
import { s3 } from "@/api/lib/s3";

type PreviewTemplateProps = {
  organizationId: SafeId<"organization">;
  templateId: string;
};

export const previewTemplateHandler = async ({
  organizationId,
  templateId,
}: PreviewTemplateProps) => {
  const template = await db.query.templates.findFirst({
    where: { id: templateId, organizationId: { eq: organizationId } },
    columns: { s3Key: true },
  });

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
