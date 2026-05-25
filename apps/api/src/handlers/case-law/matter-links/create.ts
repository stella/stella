import { count, eq } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { caseLawMatterLinks } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

export const createMatterLinkBodySchema = t.Object({
  decisionId: tSafeId("caseLawDecision"),
  note: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
});

type CreateMatterLinkBody = Static<typeof createMatterLinkBodySchema>;

type CreateMatterLinkProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  body: CreateMatterLinkBody;
  recordAuditEvent: AuditRecorder;
};

export const createMatterLinkHandler = async ({
  scopedDb,
  workspaceId,
  userId,
  body,
  recordAuditEvent,
}: CreateMatterLinkProps) => {
  const decision = await scopedDb((tx) =>
    tx.query.caseLawDecisions.findFirst({
      where: { id: { eq: body.decisionId } },
      columns: { id: true },
    }),
  );

  if (!decision) {
    return status(404, { message: "Decision not found" });
  }

  const [linkCountRow] = await scopedDb((tx) =>
    tx
      .select({ value: count() })
      .from(caseLawMatterLinks)
      .where(eq(caseLawMatterLinks.workspaceId, workspaceId)),
  );

  const linkCount = linkCountRow?.value ?? 0;

  if (linkCount >= LIMITS.caseLawMatterLinksPerWorkspace) {
    return status(400, {
      message: "Matter links limit reached",
    });
  }

  const links = await scopedDb(async (tx) => {
    const inserted = await tx
      .insert(caseLawMatterLinks)
      .values({
        decisionId: body.decisionId,
        workspaceId,
        note: body.note ?? null,
        linkedBy: userId,
      })
      .onConflictDoNothing({
        target: [caseLawMatterLinks.decisionId, caseLawMatterLinks.workspaceId],
      })
      .returning();

    const insertedLink = inserted.at(0);
    if (insertedLink) {
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_MATTER_LINK,
        resourceId: insertedLink.id,
        workspaceId,
        metadata: {
          decisionId: body.decisionId,
          hasNote: (body.note ?? null) !== null,
        },
      });
    }

    return inserted;
  });
  const link = links.at(0);

  if (!link) {
    return status(409, {
      message: "Decision already linked to this matter",
    });
  }

  return link;
};
