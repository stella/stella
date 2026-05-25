import { and, eq } from "drizzle-orm";
import { status } from "elysia";

import type { ScopedDb } from "@/api/db";
import { caseLawMatterLinks } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";

type DeleteMatterLinkProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  linkId: SafeId<"caseLawMatterLink">;
  recordAuditEvent: AuditRecorder;
};

export const deleteMatterLinkHandler = async ({
  scopedDb,
  workspaceId,
  linkId,
  recordAuditEvent,
}: DeleteMatterLinkProps) => {
  const deleted = await scopedDb(async (tx) => {
    const rows = await tx
      .delete(caseLawMatterLinks)
      .where(
        and(
          eq(caseLawMatterLinks.id, linkId),
          eq(caseLawMatterLinks.workspaceId, workspaceId),
        ),
      )
      .returning({ id: caseLawMatterLinks.id });

    if (rows.length > 0) {
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.DELETE,
        resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_MATTER_LINK,
        resourceId: linkId,
        workspaceId,
      });
    }

    return rows;
  });

  if (deleted.length === 0) {
    return status(404, { message: "Matter link not found" });
  }

  return { success: true };
};
