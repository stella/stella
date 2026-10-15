import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { resultTx } from "@/api/db/safe-db";
import type { SafeDb } from "@/api/db/safe-db";
import { playbookDefinitions } from "@/api/db/schema";
import {
  assertPlaybookDocumentType,
  mapPlaybookDocumentTypeError,
} from "@/api/handlers/playbooks/assert-document-type";
import { deriveAutoAsks } from "@/api/handlers/playbooks/derive-ask";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { OrgAIConfigStatus } from "@/api/lib/ai-config-loader-core";
import type { SafeHandlerGenerator } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { assertUnchangedSince } from "@/api/lib/optimistic-concurrency";
import type { ModelActionAdmitter } from "@/api/lib/rate-limit/model-action-admission";
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
  /** Admits the save's ask derivations; see `deriveAutoAsks`. */
  admitModelAction: ModelActionAdmitter;
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  /** Matters the caller can access; a newly added source must be in one. */
  accessibleWorkspaceIds: readonly SafeId<"workspace">[];
  playbookId: SafeId<"playbookDefinition">;
  orgAIConfig: OrgAIConfig | null;
  managedAIResidency: ManagedAIResidency;
  orgAIConfigStatus: OrgAIConfigStatus;
  promptCachingEnabled: boolean;
  recordAuditEvent: AuditRecorder;
  body: UpdatePlaybookDefinitionBody;
};

export const updatePlaybookDefinitionHandler = async function* ({
  admitModelAction,
  safeDb,
  organizationId,
  accessibleWorkspaceIds,
  playbookId,
  orgAIConfig,
  managedAIResidency,
  orgAIConfigStatus,
  promptCachingEnabled,
  recordAuditEvent,
  body,
}: UpdatePlaybookDefinitionArgs): SafeHandlerGenerator<{ updatedAt: string }> {
  // Read the stored positions to tell which sources this save adds and which
  // the playbook already had; only added sources need an access check. This
  // read happens before the row lock below. That is safe because both callers
  // send `expectedUpdatedAt`: if the playbook changes in between, the save
  // fails instead of being checked against an outdated list. A caller that
  // omits the token can at worst keep a source that was stored a moment ago.
  const stored = yield* Result.await(
    safeDb((tx) =>
      tx.query.playbookDefinitions.findFirst({
        where: {
          id: { eq: playbookId },
          organizationId: { eq: organizationId },
        },
        columns: { positions: true },
      }),
    ),
  );
  if (!stored) {
    return Result.err(
      new HandlerError({ status: 404, message: "Playbook not found" }),
    );
  }

  yield* Result.await(
    assertPositionsValid({
      safeDb,
      organizationId,
      accessibleWorkspaceIds,
      positions: body.positions,
      storedPositions: stored.positions,
    }),
  );

  // Derive auto-ASK questions from tier rules before persisting. A stored
  // `derived` whose `rulesHash` still matches is reused (no LLM call); a
  // failed derivation persists with `derived` absent.
  const positions = await deriveAutoAsks(body.positions, {
    admitModelAction,
    organizationId,
    orgAIConfig,
    managedAIResidency,
    orgAIConfigStatus,
    promptCachingEnabled,
  });

  const updated = yield* Result.await(
    resultTx(safeDb, async (tx) => {
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
        return Result.err(
          new HandlerError({ status: 404, message: "Playbook not found" }),
        );
      }

      const conflict = assertUnchangedSince({
        storedUpdatedAt: locked.updatedAt,
        expectedUpdatedAt: body.expectedUpdatedAt,
        resource: "Playbook",
      });
      if (conflict) {
        return Result.err(conflict);
      }

      const documentType = await assertPlaybookDocumentType({
        tx,
        organizationId,
        scope: body.scope,
      });
      if (documentType.isErr()) {
        return Result.err(documentType.error);
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
        return Result.err(
          new HandlerError({ status: 404, message: "Playbook not found" }),
        );
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

      return Result.ok({ updatedAt: row.updatedAt });
    }).then((result) => result.mapError(mapPlaybookDocumentTypeError)),
  );

  // Return the new concurrency token without a refetch.
  return Result.ok({ updatedAt: updated.updatedAt.toISOString() });
};
