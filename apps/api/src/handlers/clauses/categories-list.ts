import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import { listCategoriesHandler } from "./categories";

const config = {
  description:
    "List the organization's clause categories in sort order, each with its " +
    "id, parent, name, description, and sort order. The taxonomy is capped " +
    "per organization and comes back whole; there is no pagination.",
  permissions: { workspace: ["read"] },
  mcp: { type: "covered", by: "list_clauses" },
  access: "read",
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
