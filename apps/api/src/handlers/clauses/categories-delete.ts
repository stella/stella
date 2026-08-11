import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";

import { deleteCategoryHandler } from "./categories";

const deleteClauseCategoryParamsSchema = t.Object({
  categoryId: tSafeId("clauseCategory"),
});

const config = {
  description:
    "Delete one category from the organization's clause library taxonomy. No " +
    "clause is deleted: clauses filed under the category become uncategorized, " +
    "and its child categories are re-parented to its own parent.",
  permissions: { clause: ["delete"] },
  mcp: { type: "capability", reason: "knowledge_library_admin" },
  params: deleteClauseCategoryParamsSchema,
} satisfies HandlerConfig;

const deleteClauseCategory = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, recordAuditEvent }) {
    return yield* deleteCategoryHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      categoryId: params.categoryId,
      recordAuditEvent,
    });
  },
);

export default deleteClauseCategory;
