import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import { listCategoriesHandler } from "./categories";

const config = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

const listClauseCategories = createRootHandler(
  config,
  async ({ scopedDb, session }) =>
    await listCategoriesHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
    }),
);

export default listClauseCategories;
