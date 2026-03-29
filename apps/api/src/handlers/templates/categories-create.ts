import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import {
  createTemplateCategoryBodySchema,
  createTemplateCategoryHandler,
} from "./categories";

const config = {
  permissions: { template: ["create"] },
  body: createTemplateCategoryBodySchema,
} satisfies HandlerConfig;

const createTemplateCategory = createRootHandler(
  config,
  async ({ scopedDb, session, body }) =>
    await createTemplateCategoryHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      body,
    }),
);

export default createTemplateCategory;
