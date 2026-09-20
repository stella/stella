import {
  playbookDefinitionParamsSchema,
  updatePlaybookDefinitionBodySchema,
} from "@/api/handlers/playbooks/schema";
import { updatePlaybookDefinitionHandler } from "@/api/handlers/playbooks/update-shared";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  description:
    "Replace a playbook definition's name, description, scope, and " +
    "positions; the positions are validated and their automatic questions " +
    "re-derived. Any edit invalidates a prior approval, so the playbook " +
    "drops back to draft with its approval metadata cleared and runs keep " +
    "using the last approved version until it is approved again. Pass " +
    "expectedUpdatedAt as a concurrency token; a definition changed since " +
    "you read it is a conflict, and the new updatedAt comes back for the " +
    "next save.",
  permissions: { playbook: ["update"] },
  mcp: { type: "capability", reason: "knowledge_library_admin" },
  params: playbookDefinitionParamsSchema,
  body: updatePlaybookDefinitionBodySchema,
} satisfies HandlerConfig;

const updatePlaybookDefinition = createSafeRootHandler(
  config,
  async function* ({
    safeDb,
    session,
    params,
    body,
    recordAuditEvent,
    orgAIConfig,
    orgAIConfigStatus,
    promptCachingEnabled,
  }) {
    return yield* updatePlaybookDefinitionHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      playbookId: params.playbookId,
      orgAIConfig,
      orgAIConfigStatus,
      promptCachingEnabled,
      recordAuditEvent,
      body,
    });
  },
);

export default updatePlaybookDefinition;
