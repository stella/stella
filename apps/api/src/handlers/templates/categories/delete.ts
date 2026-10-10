import { Result } from "better-result";
import { t } from "elysia";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";

import { deleteTemplateCategoryHandler } from "../categories";

const deleteTemplateCategoryParamsSchema = t.Object({
  categoryId: tSafeId("templateCategory"),
});

const config = {
  description:
    "Delete one category from the organization's template category tree. No " +
    "template is deleted: templates filed under the category become " +
    "uncategorized, and its child categories are promoted to its own parent.",
  permissions: { template: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "template_authoring_ui",
    consumesServices: false,
  },
  params: deleteTemplateCategoryParamsSchema,
} satisfies HandlerConfig;

const deleteTemplateCategory = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session, params, recordAuditEvent }) {
    const result = yield* Result.await(
      deleteTemplateCategoryHandler({
        scopedDb,
        organizationId: session.activeOrganizationId,
        categoryId: params.categoryId,
        recordAuditEvent,
      }),
    );
    return Result.ok(result);
  },
);

export default deleteTemplateCategory;
