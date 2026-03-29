import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import { createCategoryBodySchema, createCategoryHandler } from "./categories";

const config = {
  permissions: { clause: ["create"] },
  body: createCategoryBodySchema,
} satisfies HandlerConfig;

const createClauseCategory = createRootHandler(
  config,
  async ({ scopedDb, session, body }) =>
    await createCategoryHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      body,
    }),
);

export default createClauseCategory;
