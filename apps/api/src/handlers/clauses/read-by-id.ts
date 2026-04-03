import { t } from "elysia";

import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

import { getClauseHandler } from "./read";

const getClauseParamsSchema = t.Object({
  clauseId: tNanoid,
});

const config = {
  permissions: { workspace: ["read"] },
  params: getClauseParamsSchema,
} satisfies HandlerConfig;

const getClause = createRootHandler(
  config,
  async ({ scopedDb, session, params }) =>
    await getClauseHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      clauseId: params.clauseId,
    }),
);

export default getClause;
