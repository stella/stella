import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { playbookDefinitions } from "@/api/db/schema";
import { deriveAutoAsks } from "@/api/handlers/playbooks/derive-ask";
import {
  playbookDefinitionParamsSchema,
  updatePlaybookDefinitionBodySchema,
} from "@/api/handlers/playbooks/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { assertUnchangedSince } from "@/api/lib/optimistic-concurrency";
import { assertPositionsValid } from "@/api/lib/workflow/playbook-positions-validation";

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
    promptCachingEnabled,
  }) {
    const organizationId = session.activeOrganizationId;

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
              eq(playbookDefinitions.id, params.playbookId),
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
              eq(playbookDefinitions.id, params.playbookId),
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
          resourceId: params.playbookId,
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
        // Handed back so the editor reseeds its concurrency token in place,
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
  },
);

export default updatePlaybookDefinition;
