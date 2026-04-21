import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tUuid } from "@/api/lib/custom-schema";

import { deleteCategoryHandler } from "./categories";

const deleteClauseCategoryParamsSchema = t.Object({
  categoryId: tUuid,
});

const config = {
  permissions: { clause: ["delete"] },
  params: deleteClauseCategoryParamsSchema,
} satisfies HandlerConfig;

const deleteClauseCategory = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params }) {
    return yield* deleteCategoryHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      categoryId: params.categoryId,
    });
  },
);

export default deleteClauseCategory;
