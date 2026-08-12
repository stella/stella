import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import { createCategoryBodySchema, createCategoryHandler } from "./categories";

const config = {
  description:
    "Create a category in the organization's clause library taxonomy, " +
    "optionally under a parent category. Refused once the organization holds " +
    "its maximum number of categories, or when the named parent does not " +
    "exist.",
  permissions: { clause: ["create"] },
  mcp: { type: "capability", reason: "knowledge_library_admin" },
  body: createCategoryBodySchema,
} satisfies HandlerConfig;

const createClauseCategory = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body, recordAuditEvent }) {
    return yield* createCategoryHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      body,
      recordAuditEvent,
    });
  },
);

export default createClauseCategory;
