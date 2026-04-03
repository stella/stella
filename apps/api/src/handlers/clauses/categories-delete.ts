import { t } from "elysia";

import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

import { deleteCategoryHandler } from "./categories";

const deleteClauseCategoryParamsSchema = t.Object({
  categoryId: tNanoid,
});

const config = {
  permissions: { clause: ["delete"] },
  params: deleteClauseCategoryParamsSchema,
} satisfies HandlerConfig;

const deleteClauseCategory = createRootHandler(
  config,
  async ({ scopedDb, session, params }) =>
    await deleteCategoryHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      categoryId: params.categoryId,
    }),
);

export default deleteClauseCategory;
