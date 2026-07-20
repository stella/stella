import { getFlowDefinitionHandler } from "@/api/handlers/flows/read";
import { flowDefinitionParamsSchema } from "@/api/handlers/flows/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "workflow_orchestration" },
  params: flowDefinitionParamsSchema,
} satisfies HandlerConfig;

const getFlowDefinition = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params }) {
    return yield* getFlowDefinitionHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      flowId: params.flowId,
    });
  },
);

export default getFlowDefinition;
