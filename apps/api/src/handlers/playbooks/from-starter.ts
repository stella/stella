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
  description:
    "Create or reopen the organization's playbook from a bundled starter, " +
    "cloning its positions with fresh ids on first use and otherwise taking exactly the path " +
    "playbooks.create takes, including validation, the per-organization " +
    "limit, and the draft status. Repeated use of one starter returns the " +
    "existing playbook instead of creating a copy. Browse the starters with " +
    "playbooks.list-starters.",
  permissions: { playbook: ["create"] },
  mcp: { type: "capability", reason: "knowledge_library_admin" },
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
      origin: { type: "starter", starterId: starter.starterId },
    });
  },
);

export default createPlaybookFromStarter;
