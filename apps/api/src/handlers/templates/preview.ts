import { Result } from "better-result";
import { t } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { renderTemplatePreview } from "@/api/lib/docx/render-template-preview";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readS3ArrayBuffer } from "@/api/lib/s3";

const previewTemplateParamsSchema = t.Object({
  templateId: tSafeId("template"),
});

type PreviewTemplateProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
};

const previewTemplateHandler = async function* ({
  safeDb,
  organizationId,
  templateId,
}: PreviewTemplateProps) {
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

  const docxBytes = await readS3ArrayBuffer(template.s3Key);
  return Result.ok(await renderTemplatePreview(docxBytes));
};

const config = {
  description:
    "Read one stored template as text for display: its paragraphs tagged " +
    "with header, body, or footer origin, the character count, the " +
    "structural marker errors positioned against those paragraphs, and the " +
    "names of its clause slots.",
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  access: "read",
  params: previewTemplateParamsSchema,
} satisfies HandlerConfig;

const previewTemplate = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params }) {
    return yield* previewTemplateHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      templateId: params.templateId,
    });
  },
);

export default previewTemplate;
