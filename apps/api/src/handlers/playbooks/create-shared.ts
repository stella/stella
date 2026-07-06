import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db";
import { playbookDefinitions } from "@/api/db/schema";
import { deriveAutoAsks } from "@/api/handlers/playbooks/derive-ask";
import type {
  PlaybookPositions,
  PlaybookScope,
} from "@/api/handlers/playbooks/positions";
import { assertPositionsValid } from "@/api/handlers/playbooks/positions-validation";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { SafeHandlerGenerator } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

// The one create path every playbook-creating surface shares: the manual
// editor's "New playbook" save (create.ts) and the one-click starter
// instantiation (from-starter.ts). Keeping validation, ASK derivation, the
// per-org cap, and the audit row in one place means a starter playbook is
// exercised through exactly the same invariants as a hand-authored one.

export type CreatePlaybookDefinitionBody = {
  name: string;
  description?: string;
  scope?: PlaybookScope;
  positions: PlaybookPositions;
};

export type CreatePlaybookDefinitionResult = {
  id: SafeId<"playbookDefinition">;
};

type CreatePlaybookDefinitionArgs = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  recordAuditEvent: AuditRecorder;
  body: CreatePlaybookDefinitionBody;
};

export const createPlaybookDefinitionHandler = async function* ({
  safeDb,
  organizationId,
  orgAIConfig,
  promptCachingEnabled,
  recordAuditEvent,
  body,
}: CreatePlaybookDefinitionArgs): SafeHandlerGenerator<CreatePlaybookDefinitionResult> {
  yield* Result.await(
    assertPositionsValid({
      safeDb,
      organizationId,
      positions: body.positions,
    }),
  );

  // Derive auto-ASK questions from tier rules before persisting so run/review
  // consume `derived` like a manual ask. A failed derivation never blocks the
  // save (it persists with `derived` absent).
  const positions = await deriveAutoAsks(body.positions, {
    organizationId,
    orgAIConfig,
    promptCachingEnabled,
  });

  const documentTypeKey = body.scope?.documentTypeKey;
  if (documentTypeKey !== undefined) {
    const documentType = yield* Result.await(
      safeDb((tx) =>
        tx.query.documentTypes.findFirst({
          where: {
            organizationId: { eq: organizationId },
            key: { eq: documentTypeKey },
          },
          columns: { id: true },
        }),
      ),
    );

    if (!documentType) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Document type not found in this organization",
        }),
      );
    }
  }

  const existingCount = yield* Result.await(
    safeDb((tx) =>
      tx.$count(
        playbookDefinitions,
        eq(playbookDefinitions.organizationId, organizationId),
      ),
    ),
  );

  if (existingCount >= LIMITS.playbookDefinitionsCount) {
    return Result.err(
      new HandlerError({ status: 400, message: "Playbook limit reached" }),
    );
  }

  const playbookId = createSafeId<"playbookDefinition">();

  const inserted = yield* Result.await(
    safeDb(async (tx) => {
      const [row] = await tx
        .insert(playbookDefinitions)
        .values({
          id: playbookId,
          organizationId,
          name: body.name,
          description: body.description ?? null,
          scope: body.scope ?? null,
          positions,
        })
        .returning({ id: playbookDefinitions.id });

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.PLAYBOOK,
        resourceId: playbookId,
        changes: {
          created: {
            old: null,
            new: {
              name: body.name,
              positionCount: body.positions.items.length,
            },
          },
        },
      });

      return row;
    }),
  );

  if (!inserted) {
    panic("Failed to create playbook definition");
  }

  return Result.ok({ id: inserted.id });
};
