import { createPlaybookDefinitionHandler } from "@/api/handlers/playbooks/create-shared";
import { playbookDefinitionBodySchema } from "@/api/handlers/playbooks/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { playbook: ["create"] },
  mcp: { type: "capability", reason: "knowledge_library_admin" },
  body: playbookDefinitionBodySchema,
} satisfies HandlerConfig;

const createPlaybookDefinition = createSafeRootHandler(
  config,
  async function* ({
    safeDb,
    session,
    body,
    recordAuditEvent,
    orgAIConfig,
    promptCachingEnabled,
  }) {
    return yield* createPlaybookDefinitionHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      orgAIConfig,
      promptCachingEnabled,
      recordAuditEvent,
      body,
    });
  },
);

export default createPlaybookDefinition;
