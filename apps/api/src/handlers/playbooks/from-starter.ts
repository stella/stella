import { Result } from "better-result";
import { t } from "elysia";

import { createPlaybookDefinitionHandler } from "@/api/handlers/playbooks/create-shared";
import { instantiateStarterPositions } from "@/api/handlers/playbooks/instantiate-starter";
import {
  findStarterPlaybook,
  STARTER_PLAYBOOK_IDS,
} from "@/api/handlers/playbooks/starters";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const fromStarterBodySchema = t.Object({
  starterId: t.UnionEnum(STARTER_PLAYBOOK_IDS),
});

const config = {
  permissions: { playbook: ["create"] },
  mcp: { type: "pending" },
  body: fromStarterBodySchema,
} satisfies HandlerConfig;

// Instantiates one of the ready-made starter playbooks into the acting org:
// clones the starter's positions with fresh ids (see instantiate-starter.ts)
// and rides the exact same create path (validation, ASK derivation, the
// per-org cap, and the audit row) as a hand-authored playbook.
const createPlaybookFromStarter = createSafeRootHandler(
  config,
  async function* ({
    body,
    orgAIConfig,
    promptCachingEnabled,
    recordAuditEvent,
    safeDb,
    session,
  }) {
    const starter = findStarterPlaybook(body.starterId);
    if (!starter) {
      return Result.err(
        new HandlerError({ status: 404, message: "Unknown starter playbook" }),
      );
    }

    return yield* createPlaybookDefinitionHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      orgAIConfig,
      promptCachingEnabled,
      recordAuditEvent,
      body: {
        name: starter.name,
        description: starter.description,
        scope: { documentTypeKey: starter.documentTypeKey },
        positions: instantiateStarterPositions(starter.positions),
      },
    });
  },
);

export default createPlaybookFromStarter;
