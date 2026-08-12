import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import { getPlaybookDefinitionHandler } from "./read";
import { playbookDefinitionParamsSchema } from "./schema";

const config = {
  description:
    "Read one playbook definition in full: its name, description, " +
    "document-type scope, positions, status, and approval metadata. Use " +
    "playbooks.list for the paginated overview.",
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
