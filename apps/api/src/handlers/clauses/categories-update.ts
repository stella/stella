import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tUuid } from "@/api/lib/custom-schema";

import { updateCategoryBodySchema, updateCategoryHandler } from "./categories";

const updateClauseCategoryParamsSchema = t.Object({
  categoryId: tUuid,
});

const config = {
  permissions: { clause: ["update"] },
  params: updateClauseCategoryParamsSchema,
  body: updateCategoryBodySchema,
} satisfies HandlerConfig;

const updateClauseCategory = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, body }) {
    return yield* updateCategoryHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      categoryId: params.categoryId,
      body,
    });
  },
);

export default updateClauseCategory;
