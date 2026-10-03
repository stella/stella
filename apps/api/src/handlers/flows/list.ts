import { listFlowDefinitionsHandler } from "@/api/handlers/flows/read";
import { listFlowDefinitionsQuerySchema } from "@/api/handlers/flows/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS } from "@/api/lib/auth/demo-account-policy";

const config = {
  description:
    "List flow definitions available to the organization, with optional status filtering and pagination.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "workflow_orchestration",
    consumesServices: false,
  },
  access: "read",
  query: listFlowDefinitionsQuerySchema,
} satisfies HandlerConfig;

const listFlowDefinitions = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, query }) {
    return yield* listFlowDefinitionsHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      query,
    });
  },
);

export default listFlowDefinitions;
