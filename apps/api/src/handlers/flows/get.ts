import { getFlowDefinitionHandler } from "@/api/handlers/flows/read";
import { flowDefinitionParamsSchema } from "@/api/handlers/flows/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  description:
    "Read one flow definition: its name, description, steps, trigger, and " +
    "enabled flag. Use flows.list to browse the organization's flows and " +
    "flows.run-detail to read a run of one.",
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "workflow_orchestration" },
  access: "read",
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
