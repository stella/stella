import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import { listClausesHandler, listClausesQuerySchema } from "./read";

const config = {
  description:
    "List the organization's clause library. Without q, clauses come back " +
    "newest first with cursor pagination; with q they are matched on the " +
    "title as a substring or on the clause text as a prefix search, ordered " +
    "by title, and no cursor is returned. Filter by categoryId. Items carry " +
    "title, category, language, description, and current version but not the " +
    "body: read that with clauses.get.",
  permissions: { workspace: ["read"] },
  mcp: { type: "tool", name: "list_clauses" },
  access: "read",
  query: listClausesQuerySchema,
} satisfies HandlerConfig;

const listClauses = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, query }) {
    return yield* listClausesHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      query,
    });
  },
);

export default listClauses;
