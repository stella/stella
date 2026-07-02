import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import {
  listPlaybookDefinitionsHandler,
  listPlaybookDefinitionsQuerySchema,
} from "./read";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "pending" },
  query: listPlaybookDefinitionsQuerySchema,
} satisfies HandlerConfig;

const listPlaybookDefinitions = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, query }) {
    return yield* listPlaybookDefinitionsHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      query,
    });
  },
);

export default listPlaybookDefinitions;
