import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import { listClausesHandler, listClausesQuerySchema } from "./read";

const config = {
  permissions: { workspace: ["read"] },
  query: listClausesQuerySchema,
} satisfies HandlerConfig;

const listClauses = createRootHandler(
  config,
  async ({ scopedDb, session, query }) =>
    await listClausesHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      query,
    }),
);

export default listClauses;
