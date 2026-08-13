import { panic, Result } from "better-result";
import { eq, isNotNull } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { playbookDefinitions } from "@/api/db/schema";
import { deriveAutoAsks } from "@/api/handlers/playbooks/derive-ask";
import type { StarterPlaybookId } from "@/api/handlers/playbooks/starters";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { SafeHandlerGenerator } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import type {
  PlaybookPositions,
  PlaybookScope,
} from "@/api/lib/workflow/playbook-positions";
import { assertPositionsValid } from "@/api/lib/workflow/playbook-positions-validation";

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
  outcome: "created" | "existing";
};

export type CreatePlaybookDefinitionOrigin =
  | { type: "authored" }
  | { type: "starter"; starterId: StarterPlaybookId };

type CreatePlaybookDefinitionArgs = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  recordAuditEvent: AuditRecorder;
  body: CreatePlaybookDefinitionBody;
  origin: CreatePlaybookDefinitionOrigin;
};

export const createPlaybookDefinitionHandler = async function* ({
  safeDb,
  organizationId,
  orgAIConfig,
  promptCachingEnabled,
  recordAuditEvent,
  body,
  origin,
}: CreatePlaybookDefinitionArgs): SafeHandlerGenerator<CreatePlaybookDefinitionResult> {
  if (origin.type === "starter") {
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.playbookDefinitions.findFirst({
          where: {
            organizationId: { eq: organizationId },
            starterId: { eq: origin.starterId },
          },
          columns: { id: true },
        }),
      ),
    );
    if (existing) {
      return Result.ok({ id: existing.id, outcome: "existing" });
    }
  }

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

  const persisted = yield* Result.await(
    safeDb(async (tx) => {
      const values = {
        id: playbookId,
        organizationId,
        name: body.name,
        starterId: origin.type === "starter" ? origin.starterId : null,
        description: body.description ?? null,
        scope: body.scope ?? null,
        positions,
      };
      const rows =
        origin.type === "starter"
          ? await tx
              .insert(playbookDefinitions)
              .values(values)
              .onConflictDoNothing({
                target: [
                  playbookDefinitions.organizationId,
                  playbookDefinitions.starterId,
                ],
                where: isNotNull(playbookDefinitions.starterId),
              })
              .returning({ id: playbookDefinitions.id })
          : await tx
              .insert(playbookDefinitions)
              .values(values)
              .returning({ id: playbookDefinitions.id });
      const row = rows.at(0);

      if (!row && origin.type === "starter") {
        const existing = await tx.query.playbookDefinitions.findFirst({
          where: {
            organizationId: { eq: organizationId },
            starterId: { eq: origin.starterId },
          },
          columns: { id: true },
        });
        if (!existing) {
          panic("Starter playbook insert conflicted without a matching row");
        }
        return { id: existing.id, outcome: "existing" as const };
      }

      if (!row) {
        panic("Failed to create playbook definition");
      }

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

      return { id: row.id, outcome: "created" as const };
    }),
  );

  return Result.ok(persisted);
};
