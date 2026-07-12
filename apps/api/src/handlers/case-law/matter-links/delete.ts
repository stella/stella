import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawMatterLinks } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";

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

const config = {
  permissions: { entity: ["delete"] },
  mcp: { type: "capability", reason: "legal_corpus_admin" },
  params: t.Object({
    workspaceId: tSafeId("workspace"),
    linkId: tSafeId("caseLawMatterLink"),
  }),
} satisfies HandlerConfig;

const deleteMatterLink = createSafeHandler(
  config,
  async function* ({
    params: { linkId },
    recordAuditEvent,
    scopedDb,
    workspaceId,
  }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await deleteMatterLinkHandler({
            workspaceId,
            linkId,
            scopedDb,
            recordAuditEvent,
          }),
      ),
    );

    return Result.ok(response);
  },
);

export default deleteMatterLink;
