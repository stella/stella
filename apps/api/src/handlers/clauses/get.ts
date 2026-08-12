import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";

import { getClauseHandler } from "./read";

const getClauseParamsSchema = t.Object({
  clauseId: tSafeId("clause"),
});

const config = {
  description:
    "Read one clause in full: its body, category, language, description, " +
    "usage notes, metadata, and current version number, plus every variant " +
    "in sort order and the list of its stored versions. Use " +
    "clauses.read-version for the body of a particular version.",
  permissions: { workspace: ["read"] },
  mcp: { type: "covered", by: "list_clauses" },
  access: "read",
  params: getClauseParamsSchema,
} satisfies HandlerConfig;

const getClause = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params }) {
    return yield* getClauseHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      clauseId: params.clauseId,
    });
  },
);

export default getClause;
