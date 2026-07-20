import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { anonymizationAllowlistEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";

const config = {
  permissions: { workspace: ["update"] },
  mcp: { type: "capability", reason: "anonymization_admin" },
  params: t.Object({
    workspaceId: tSafeId("workspace"),
    entryId: tSafeId("anonymizationAllowlistEntry"),
  }),
} satisfies HandlerConfig;

const deleteWorkspaceAnonymizationAllowlistEntry = createSafeHandler(
  config,
  async function* ({
    params: { entryId },
    safeDb,
    workspaceId,
    recordAuditEvent,
  }) {
    yield* Result.await(
      safeDb(async (tx) => {
        // Scope the delete to rows that live inside the current
        // workspace. Org-wide rows (workspace_id IS NULL) are
        // intentionally NOT deletable from here — the org admin
        // endpoint owns those — so a workspace editor cannot
        // accidentally (or maliciously) remove a firm-wide entry
        // that the rest of the org relies on.
        const deleted = await tx
          .delete(anonymizationAllowlistEntries)
          .where(
            and(
              eq(anonymizationAllowlistEntries.id, entryId),
              eq(anonymizationAllowlistEntries.workspaceId, workspaceId),
            ),
          )
          .returning({
            id: anonymizationAllowlistEntries.id,
            canonical: anonymizationAllowlistEntries.canonical,
            label: anonymizationAllowlistEntries.label,
            entityId: anonymizationAllowlistEntries.entityId,
          });

        if (deleted.length > 0) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
            resourceId: workspaceId,
            changes: {
              anonymizationAllowlist: {
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

export default deleteWorkspaceAnonymizationAllowlistEntry;
