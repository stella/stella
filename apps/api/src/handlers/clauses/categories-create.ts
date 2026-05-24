import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import { createCategoryBodySchema, createCategoryHandler } from "./categories";

const config = {
  permissions: { clause: ["create"] },
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
