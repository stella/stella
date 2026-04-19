import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import { listClausesHandler, listClausesQuerySchema } from "./read";

const config = {
  permissions: { workspace: ["read"] },
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
