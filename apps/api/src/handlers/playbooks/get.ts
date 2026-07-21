import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import { getPlaybookDefinitionHandler } from "./read";
import { playbookDefinitionParamsSchema } from "./schema";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "covered", by: "list_playbooks" },
  access: "read",
  params: playbookDefinitionParamsSchema,
} satisfies HandlerConfig;

const getPlaybookDefinition = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params }) {
    return yield* getPlaybookDefinitionHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      playbookId: params.playbookId,
    });
  },
);

export default getPlaybookDefinition;
