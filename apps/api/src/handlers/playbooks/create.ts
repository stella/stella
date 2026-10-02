import { Result } from "better-result";

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
  mcp: { type: "tool", name: "save_playbook" },
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
    managedAIResidency,
    orgAIConfigStatus,
    promptCachingEnabled,
    getActiveWorkspaceIds,
  }) {
    const accessibleWorkspaceIds = yield* Result.await(
      Result.tryPromise(async () => await getActiveWorkspaceIds()),
    );
    return yield* createPlaybookDefinitionHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      accessibleWorkspaceIds,
      orgAIConfig,
      managedAIResidency,
      orgAIConfigStatus,
      promptCachingEnabled,
      recordAuditEvent,
      body,
      origin: { type: "authored" },
    });
  },
);

export default createPlaybookDefinition;
