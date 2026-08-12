import { createPlaybookDefinitionHandler } from "@/api/handlers/playbooks/create-shared";
import { playbookDefinitionBodySchema } from "@/api/handlers/playbooks/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  description:
    "Create a playbook definition in the organization from a name, an " +
    "optional description, an optional document-type scope, and its " +
    "positions. The positions are validated and the automatic questions " +
    "derived from their tier rules before storage. It starts as a draft: " +
    "approve it with playbooks.approve before runs will use it.",
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
