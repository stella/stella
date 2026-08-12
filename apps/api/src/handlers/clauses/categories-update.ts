import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";

import { updateCategoryBodySchema, updateCategoryHandler } from "./categories";

const updateClauseCategoryParamsSchema = t.Object({
  categoryId: tSafeId("clauseCategory"),
});

const config = {
  description:
    "Rename or re-describe one clause category, move it under a different " +
    "parent (or to the root by passing null), or change its sort order. Only " +
    "the fields you pass are written. A category cannot become its own " +
    "parent, and a move that would make the tree circular is refused.",
  permissions: { clause: ["update"] },
  mcp: { type: "capability", reason: "knowledge_library_admin" },
  params: updateClauseCategoryParamsSchema,
  body: updateCategoryBodySchema,
} satisfies HandlerConfig;

const updateClauseCategory = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, body, recordAuditEvent }) {
    return yield* updateCategoryHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      categoryId: params.categoryId,
      body,
      recordAuditEvent,
    });
  },
);

export default updateClauseCategory;
