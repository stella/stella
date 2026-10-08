import { Result } from "better-result";

import {
  playbookDefinitionParamsSchema,
  updatePlaybookDefinitionBodySchema,
} from "@/api/handlers/playbooks/schema";
import { updatePlaybookDefinitionHandler } from "@/api/handlers/playbooks/update-shared";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createModelActionAdmitter } from "@/api/lib/rate-limit/model-action-admission";

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
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "covered", by: "save_playbook" },
  params: playbookDefinitionParamsSchema,
  body: updatePlaybookDefinitionBodySchema,
} satisfies HandlerConfig;

const updatePlaybookDefinition = createSafeRootHandler(
  config,
  async function* ({
    safeDb,
    scopedDb,
    session,
    user,
    params,
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
    return yield* updatePlaybookDefinitionHandler({
      admitModelAction: createModelActionAdmitter({
        organizationId: session.activeOrganizationId,
        userId: user.id,
        organizationStateDb: scopedDb,
        actionKind: "playbooks.derive-ask",
      }),
      safeDb,
      organizationId: session.activeOrganizationId,
      accessibleWorkspaceIds,
      playbookId: params.playbookId,
      orgAIConfig,
      managedAIResidency,
      orgAIConfigStatus,
      promptCachingEnabled,
      recordAuditEvent,
      body,
    });
  },
);

export default updatePlaybookDefinition;
