import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { anonymizationBlacklistEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";

const config = {
  permissions: { workspace: ["update"] },
  mcp: { type: "capability", reason: "anonymization_admin" },
  params: t.Object({
    workspaceId: tSafeId("workspace"),
    entryId: tSafeId("anonymizationBlacklistEntry"),
  }),
} satisfies HandlerConfig;

/**
 * Delete a single workspace-scoped term. The WHERE clause
 * scopes the delete to the request's workspace so an org-wide
 * row with the same ID (impossible by design but cheap to
 * guard) can never be removed via this endpoint.
 */
const deleteWorkspaceAnonymizationTerm = createSafeHandler(
  config,
  async function* ({
    params: { entryId },
    safeDb,
    workspaceId,
    recordAuditEvent,
  }) {
    yield* Result.await(
      safeDb(async (tx) => {
        const deleted = await tx
          .delete(anonymizationBlacklistEntries)
          .where(
            and(
              eq(anonymizationBlacklistEntries.id, entryId),
              eq(anonymizationBlacklistEntries.workspaceId, workspaceId),
            ),
          )
          .returning({
            id: anonymizationBlacklistEntries.id,
            canonical: anonymizationBlacklistEntries.canonical,
            label: anonymizationBlacklistEntries.label,
          });

        if (deleted.length > 0) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
            resourceId: workspaceId,
            changes: {
              anonymizationTerms: {
                old: { removed: deleted.at(0) },
                new: null,
              },
            },
          });
        }
      }),
    );
    return Result.ok({ success: true as const });
  },
);

export default deleteWorkspaceAnonymizationTerm;
