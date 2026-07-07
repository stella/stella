import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { playbookDefinitions } from "@/api/db/schema";
import { deriveAutoAsks } from "@/api/handlers/playbooks/derive-ask";
import { assertPositionsValid } from "@/api/handlers/playbooks/positions-validation";
import {
  playbookDefinitionBodySchema,
  playbookDefinitionParamsSchema,
} from "@/api/handlers/playbooks/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { playbook: ["update"] },
  mcp: { type: "pending" },
  params: playbookDefinitionParamsSchema,
  body: playbookDefinitionBodySchema,
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
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(playbookDefinitions.id, params.playbookId),
              eq(playbookDefinitions.organizationId, organizationId),
            ),
          )
          .returning({ id: playbookDefinitions.id });

        if (!row) {
          return null;
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

        return row;
      }),
    );

    if (!updated) {
      return Result.err(
        new HandlerError({ status: 404, message: "Playbook not found" }),
      );
    }

    return Result.ok({});
  },
);

export default updatePlaybookDefinition;
