import { t } from "elysia";

import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

import { deleteTemplateCategoryHandler } from "./categories";

const deleteTemplateCategoryParamsSchema = t.Object({
  categoryId: tNanoid,
});

const config = {
  permissions: { template: ["delete"] },
  params: deleteTemplateCategoryParamsSchema,
} satisfies HandlerConfig;

const deleteTemplateCategory = createRootHandler(
  config,
  async ({ scopedDb, session, params }) =>
    await deleteTemplateCategoryHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      categoryId: params.categoryId,
    }),
);

export default deleteTemplateCategory;
