import { t } from "elysia";

import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

import {
  updateTemplateCategoryBodySchema,
  updateTemplateCategoryHandler,
} from "./categories";

export const updateTemplateCategoryParamsSchema = t.Object({
  categoryId: tNanoid,
});

const config = {
  permissions: { template: ["update"] },
  params: updateTemplateCategoryParamsSchema,
  body: updateTemplateCategoryBodySchema,
} satisfies HandlerConfig;

const updateTemplateCategory = createRootHandler(
  config,
  async ({ scopedDb, session, params, body }) =>
    await updateTemplateCategoryHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      categoryId: params.categoryId,
      body,
    }),
);

export default updateTemplateCategory;
