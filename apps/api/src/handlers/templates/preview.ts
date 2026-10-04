import { Result } from "better-result";
import { t } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { renderTemplatePreview } from "@/api/lib/docx/render-template-preview";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  readStoredTemplateFile,
  STORED_TEMPLATE_FILE_COLUMNS,
} from "@/api/lib/templates/stored-template-file";

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
        columns: { ...STORED_TEMPLATE_FILE_COLUMNS, fileName: true },
      }),
    ),
  );

  if (!template) {
    return Result.err(
      new HandlerError({ status: 404, message: "Template not found" }),
    );
  }

  const file = yield* Result.await(
    readStoredTemplateFile({
      safeDb,
      organizationId,
      row: template,
      fileName: template.fileName,
    }),
  );

  return Result.ok(await renderTemplatePreview(file));
};

const config = {
  contentDelivery: {
    type: "none",
    reason:
      "Processes template content and returns parsed data or saved-document metadata rather than stored-file bytes.",
  },
  description:
    "Read one stored template as text for display: its paragraphs tagged " +
    "with header, body, or footer origin, the character count, the " +
    "structural marker errors positioned against those paragraphs, and the " +
    "names of its clause slots.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "template_authoring_ui",
    consumesServices: false,
  },
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
