import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";

import { getClauseHandler } from "./read";

const getClauseParamsSchema = t.Object({
  clauseId: tSafeId("clause"),
});

const config = {
  permissions: { workspace: ["read"] },
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
