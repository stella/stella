import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";

import { updateCategoryBodySchema, updateCategoryHandler } from "../categories";

const updateClauseCategoryParamsSchema = v.object({
  categoryId: resourceIdSchema("clauseCategory"),
});

const config = {
  contract: "patch",
  description:
    "Rename or re-describe one clause category, move it under a different " +
    "parent (or to the root by passing null), or change its sort order. Only " +
    "the fields you pass are written. A category cannot become its own " +
    "parent, and a move that would make the tree circular is refused.",
  permissions: { clause: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "knowledge_library_admin",
    consumesServices: false,
  },
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
