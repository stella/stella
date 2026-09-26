import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { CORRESPONDENCE_HANDLING_STATES } from "@stll/api-contract/correspondence";

import { correspondence, workspaceMembers } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Set the handling state and assignee of a matter correspondence record.",
  permissions: { workspace: ["update"] },
  mcp: { type: "capability", reason: "correspondence" },
  params: workspaceParams({ correspondenceId: tSafeId("correspondence") }),
  body: t.Object({
    handlingState: t.Union(
      CORRESPONDENCE_HANDLING_STATES.map((state) => t.Literal(state)),
    ),
    assigneeId: t.Nullable(tSafeId("user")),
  }),
} satisfies WorkspaceHandlerConfig;

const updateCorrespondence = createSafeHandler(
  config,
  async function* ({
    body,
    params: { correspondenceId },
    safeDb,
    workspaceId,
    recordAuditEvent,
  }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        if (body.assigneeId !== null) {
          const [assignee] = await tx
            .select({ userId: workspaceMembers.userId })
            .from(workspaceMembers)
            .where(
              and(
                eq(workspaceMembers.workspaceId, workspaceId),
                eq(workspaceMembers.userId, body.assigneeId),
              ),
            )
            .limit(1);
          if (assignee === undefined)
            return { type: "invalid_assignee" as const };
        }
        const [existing] = await tx
          .select({
            handlingState: correspondence.handlingState,
            assigneeId: correspondence.assigneeId,
          })
          .from(correspondence)
          .where(
            and(
              eq(correspondence.workspaceId, workspaceId),
              eq(correspondence.id, correspondenceId),
            ),
          )
          .for("update")
          .limit(1);
        if (existing === undefined) return { type: "not_found" as const };
        const [record] = await tx
          .update(correspondence)
          .set({
            handlingState: body.handlingState,
            assigneeId: body.assigneeId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(correspondence.workspaceId, workspaceId),
              eq(correspondence.id, correspondenceId),
            ),
          )
          .returning();
        if (record === undefined) return { type: "not_found" as const };
        if (
          existing.handlingState !== record.handlingState ||
          existing.assigneeId !== record.assigneeId
        ) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.CORRESPONDENCE,
            resourceId: correspondenceId,
            metadata: { subject: record.subject },
            changes: {
              handlingState: {
                old: existing.handlingState,
                new: record.handlingState,
              },
              assigneeId: { old: existing.assigneeId, new: record.assigneeId },
            },
          });
        }
        const {
          spf,
          dkim,
          dmarc,
          alignedIdentifier,
          organizationId: _organizationId,
          workspaceId: _workspaceId,
          contentHash: _contentHash,
          dedupKey: _dedupKey,
          ...publicRecord
        } = record;
        return {
          type: "ok" as const,
          record: {
            ...publicRecord,
            authentication: { spf, dkim, dmarc, alignedIdentifier },
          },
        };
      }),
    );
    switch (result.type) {
      case "ok":
        return Result.ok({ record: result.record });
      case "not_found":
        return Result.err(
          new HandlerError({
            status: 404,
            message: "Correspondence not found",
          }),
        );
      case "invalid_assignee":
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Assignee must belong to the matter",
          }),
        );
      default: {
        result satisfies never;
        return panic("Unhandled correspondence update result");
      }
    }
  },
);

export default updateCorrespondence;
