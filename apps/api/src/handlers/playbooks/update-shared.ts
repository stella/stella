import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { playbookDefinitions } from "@/api/db/schema";
import { deriveAutoAsks } from "@/api/handlers/playbooks/derive-ask";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { SafeHandlerGenerator } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { assertUnchangedSince } from "@/api/lib/optimistic-concurrency";
import type {
  PlaybookPositions,
  PlaybookScope,
} from "@/api/lib/workflow/playbook-positions";
import { assertPositionsValid } from "@/api/lib/workflow/playbook-positions-validation";

// The one update path both playbook writers share: the editor's full-replace
// PUT (update.ts) and the `save_playbook` tool, which merges its upsert into
// the stored definition first and then replaces through here. Validation, ASK
// derivation, the locked concurrency check, the draft reset, and the audit row
// cannot differ between the two.

type UpdatePlaybookDefinitionBody = {
  name: string;
  description?: string;
  scope?: PlaybookScope;
  positions: PlaybookPositions;
  expectedUpdatedAt?: string;
};

type UpdatePlaybookDefinitionArgs = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  playbookId: SafeId<"playbookDefinition">;
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  recordAuditEvent: AuditRecorder;
  body: UpdatePlaybookDefinitionBody;
};

export const updatePlaybookDefinitionHandler = async function* ({
  safeDb,
  organizationId,
  playbookId,
  orgAIConfig,
  promptCachingEnabled,
  recordAuditEvent,
  body,
}: UpdatePlaybookDefinitionArgs): SafeHandlerGenerator<{ updatedAt: string }> {
  yield* Result.await(
    assertPositionsValid({
      safeDb,
      organizationId,
      positions: body.positions,
    }),
  );

  // Derive auto-ASK questions from tier rules before persisting. A stored
  // `derived` whose `rulesHash` still matches is reused (no LLM call); a
  // failed derivation persists with `derived` absent.
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

  const updated = yield* Result.await(
    safeDb(async (tx) => {
      // Lock before comparing `updatedAt`: a check outside the row lock
      // races the very overwrite it is meant to reject.
      const [locked] = await tx
        .select({ updatedAt: playbookDefinitions.updatedAt })
        .from(playbookDefinitions)
        .where(
          and(
            eq(playbookDefinitions.id, playbookId),
            eq(playbookDefinitions.organizationId, organizationId),
          ),
        )
        .for("update");

      if (!locked) {
        return { type: "not-found" as const };
      }

      const conflict = assertUnchangedSince({
        storedUpdatedAt: locked.updatedAt,
        expectedUpdatedAt: body.expectedUpdatedAt,
        resource: "Playbook",
      });
      if (conflict) {
        return { type: "version-conflict" as const, error: conflict };
      }

      const updatedAt = new Date();
      const [row] = await tx
        .update(playbookDefinitions)
        .set({
          name: body.name,
          description: body.description ?? null,
          scope: body.scope ?? null,
          positions,
          // Any edit invalidates a prior approval, regardless of the
          // definition's current status; clear the stale approval metadata
          // so a draft never carries a prior approver/timestamp.
          status: "draft",
          approvedAt: null,
          approvedBy: null,
          updatedAt,
        })
        .where(
          and(
            eq(playbookDefinitions.id, playbookId),
            eq(playbookDefinitions.organizationId, organizationId),
          ),
        )
        .returning({ updatedAt: playbookDefinitions.updatedAt });

      if (!row) {
        return { type: "not-found" as const };
      }

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.PLAYBOOK,
        resourceId: playbookId,
        changes: {
          fields: {
            old: null,
            new: ["name", "description", "scope", "positions", "status"],
          },
        },
      });

      return { type: "updated" as const, updatedAt: row.updatedAt };
    }),
  );

  switch (updated.type) {
    case "updated":
      // Handed back so a writer reseeds its concurrency token in place,
      // without a refetch, and the next save still guards.
      return Result.ok({ updatedAt: updated.updatedAt.toISOString() });
    case "not-found":
      return Result.err(
        new HandlerError({ status: 404, message: "Playbook not found" }),
      );
    case "version-conflict":
      return Result.err(updated.error);
    default: {
      updated satisfies never;
      return panic(`Unhandled updated: ${String(updated)}`);
    }
  }
};
