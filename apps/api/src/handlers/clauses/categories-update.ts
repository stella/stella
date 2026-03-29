import { t } from "elysia";

import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

import { updateCategoryBodySchema, updateCategoryHandler } from "./categories";

export const updateClauseCategoryParamsSchema = t.Object({
  categoryId: tNanoid,
});

const config = {
  permissions: { clause: ["update"] },
  params: updateClauseCategoryParamsSchema,
  body: updateCategoryBodySchema,
} satisfies HandlerConfig;

const updateClauseCategory = createRootHandler(
  config,
  async ({ scopedDb, session, params, body }) =>
    await updateCategoryHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      categoryId: params.categoryId,
      body,
    }),
);

export default updateClauseCategory;
