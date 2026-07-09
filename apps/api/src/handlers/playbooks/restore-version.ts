import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { playbookDefinitions } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const restorePlaybookVersionParamsSchema = t.Object({
  playbookId: tSafeId("playbookDefinition"),
  version: t.Numeric({ minimum: 1 }),
});

const config = {
  permissions: { playbook: ["update"] },
  mcp: { type: "capability", reason: "knowledge_library_admin" },
  params: restorePlaybookVersionParamsSchema,
} satisfies HandlerConfig;

/**
 * Restore a stored approval-version snapshot: copy that version's
 * name/description/scope/positions back onto the definition. A restore is
 * itself an edit, so it always lands as a new `draft` (mirrors
 * `update-by-id.ts` reverting approval on any change) — it never re-approves
 * or reuses the source version's number.
 */
const restorePlaybookVersion = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;
    const playbookId = params.playbookId;

    const playbook = yield* Result.await(
      safeDb((tx) =>
        tx.query.playbookDefinitions.findFirst({
          where: {
            id: { eq: playbookId },
            organizationId: { eq: organizationId },
          },
          columns: { id: true, status: true },
        }),
      ),
    );

    if (!playbook) {
      return Result.err(
        new HandlerError({ status: 404, message: "Playbook not found" }),
      );
    }

    const version = yield* Result.await(
      safeDb((tx) =>
        tx.query.playbookDefinitionVersions.findFirst({
          where: {
            playbookDefinitionId: { eq: playbookId },
            organizationId: { eq: organizationId },
            version: { eq: params.version },
          },
          columns: {
            name: true,
            description: true,
            scope: true,
            positions: true,
          },
        }),
      ),
    );

    if (!version) {
      return Result.err(
        new HandlerError({ status: 404, message: "Version not found" }),
      );
    }

    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .update(playbookDefinitions)
          .set({
            name: version.name,
            description: version.description,
            scope: version.scope,
            positions: version.positions,
            // A restore produces a fresh draft; clear stale approval metadata
            // so it never carries the pre-restore approver/timestamp.
            status: "draft",
            approvedAt: null,
            approvedBy: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(playbookDefinitions.id, playbookId),
              eq(playbookDefinitions.organizationId, organizationId),
            ),
          );

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.PLAYBOOK,
          resourceId: playbookId,
          changes: {
            status: { old: playbook.status, new: "draft" },
            restoredFromVersion: { old: null, new: params.version },
          },
        });
      }),
    );

    return Result.ok({ status: "draft" as const });
  },
);

export default restorePlaybookVersion;
