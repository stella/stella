import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";

import { deleteTemplateCategoryHandler } from "../categories";

const deleteTemplateCategoryParamsSchema = v.object({
  categoryId: resourceIdSchema("templateCategory"),
});

const config = {
  contract: "patch",
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
