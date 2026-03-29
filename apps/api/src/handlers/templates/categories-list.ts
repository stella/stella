import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import { listTemplateCategoriesHandler } from "./categories";

const config = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

const listTemplateCategories = createRootHandler(
  config,
  async ({ scopedDb, session }) =>
    await listTemplateCategoriesHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
    }),
);

export default listTemplateCategories;
