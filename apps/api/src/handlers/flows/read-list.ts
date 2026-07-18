import { listFlowDefinitionsHandler } from "@/api/handlers/flows/read";
import { listFlowDefinitionsQuerySchema } from "@/api/handlers/flows/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "workflow_orchestration" },
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
