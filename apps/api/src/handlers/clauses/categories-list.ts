import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import { listCategoriesHandler } from "./categories";

const config = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

const listClauseCategories = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
    return yield* listCategoriesHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
    });
  },
);

export default listClauseCategories;
