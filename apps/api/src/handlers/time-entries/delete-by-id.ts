import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { BILLING_STATUS, timeEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteTimeEntryBodySchema = t.Object({
  id: tNanoid,
});

const deleteTimeEntryById = createSafeHandler(
  {
    permissions: { timeEntry: ["delete"] },
    body: deleteTimeEntryBodySchema,
  },
  async function* ({ safeDb, workspaceId, body }) {
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.timeEntries.findFirst({
          where: {
            id: body.id,
            workspaceId: { eq: workspaceId },
          },
          columns: {
            status: true,
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
        safeDb((tx) =>
          tx
            .delete(timeEntries)
            .where(
              and(
                eq(timeEntries.id, body.id),
                eq(timeEntries.workspaceId, workspaceId),
              ),
            ),
        ),
      );
      return Result.ok({ deleted: true });
    }

    // Non-draft entries get written off instead of deleted
    yield* Result.await(
      safeDb((tx) =>
        tx
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
          ),
      ),
    );

    return Result.ok({ deleted: false });
  },
);

export default deleteTimeEntryById;
