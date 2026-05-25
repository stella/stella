import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { BILLING_STATUS, timeEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteTimeEntryBodySchema = t.Object({
  id: tSafeId("timeEntry"),
});

const deleteTimeEntryById = createSafeHandler(
  {
    permissions: { timeEntry: ["delete"] },
    body: deleteTimeEntryBodySchema,
  },
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.timeEntries.findFirst({
          where: {
            id: { eq: body.id },
            workspaceId: { eq: workspaceId },
          },
          columns: {
            status: true,
            matterId: true,
            dateWorked: true,
            durationMinutes: true,
            billedMinutes: true,
            rateAtEntry: true,
            currency: true,
            billable: true,
          },
        }),
      ),
    );

    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "Time entry not found" }),
      );
    }

    if (existing.status === BILLING_STATUS.DRAFT) {
      yield* Result.await(
        safeDb(async (tx) => {
          await tx
            .delete(timeEntries)
            .where(
              and(
                eq(timeEntries.id, body.id),
                eq(timeEntries.workspaceId, workspaceId),
              ),
            );

          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
            resourceId: body.id,
            changes: {
              deleted: {
                old: {
                  matterId: existing.matterId,
                  dateWorked: existing.dateWorked,
                  durationMinutes: existing.durationMinutes,
                  billedMinutes: existing.billedMinutes,
                  rateAtEntry: existing.rateAtEntry,
                  currency: existing.currency,
                  billable: existing.billable,
                },
                new: null,
              },
            },
          });
        }),
      );
      return Result.ok({ deleted: true });
    }

    // Non-draft entries get written off instead of deleted
    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .update(timeEntries)
          .set({
            status: BILLING_STATUS.WRITTEN_OFF,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(timeEntries.id, body.id),
              eq(timeEntries.workspaceId, workspaceId),
            ),
          );

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
          resourceId: body.id,
          changes: {
            status: {
              old: existing.status,
              new: BILLING_STATUS.WRITTEN_OFF,
            },
          },
        });
      }),
    );

    return Result.ok({ deleted: false });
  },
);

export default deleteTimeEntryById;
