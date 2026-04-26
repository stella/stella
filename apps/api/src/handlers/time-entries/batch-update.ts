import { Result } from "better-result";
import { and, eq, inArray, ne } from "drizzle-orm";
import { t } from "elysia";

import { BILLING_STATUS, timeEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const batchUpdateBodySchema = t.Object({
  ids: t.Array(tSafeId("timeEntry"), { minItems: 1, maxItems: 200 }),
  action: t.UnionEnum([
    "approve",
    "revert_to_draft",
    "mark_billable",
    "mark_non_billable",
  ]),
});

const batchUpdate = createSafeHandler(
  {
    permissions: { timeEntry: ["update"] },
    body: batchUpdateBodySchema,
  },
  async function* ({ safeDb, workspaceId, body }) {
    const { ids, action } = body;

    const condition = and(
      eq(timeEntries.workspaceId, workspaceId),
      inArray(timeEntries.id, ids),
    );

    switch (action) {
      case "approve": {
        const rows = yield* Result.await(
          safeDb((tx) =>
            tx
              .update(timeEntries)
              .set({ status: BILLING_STATUS.APPROVED, updatedAt: new Date() })
              .where(
                and(condition, eq(timeEntries.status, BILLING_STATUS.DRAFT)),
              )
              .returning({ id: timeEntries.id }),
          ),
        );
        return Result.ok({ updated: rows.length });
      }

      case "revert_to_draft": {
        const rows = yield* Result.await(
          safeDb((tx) =>
            tx
              .update(timeEntries)
              .set({ status: BILLING_STATUS.DRAFT, updatedAt: new Date() })
              .where(
                and(condition, eq(timeEntries.status, BILLING_STATUS.APPROVED)),
              )
              .returning({ id: timeEntries.id }),
          ),
        );
        return Result.ok({ updated: rows.length });
      }

      case "mark_billable": {
        const rows = yield* Result.await(
          safeDb((tx) =>
            tx
              .update(timeEntries)
              .set({ billable: true, updatedAt: new Date() })
              .where(
                and(
                  condition,
                  ne(timeEntries.status, BILLING_STATUS.BILLED),
                  ne(timeEntries.status, BILLING_STATUS.WRITTEN_OFF),
                ),
              )
              .returning({ id: timeEntries.id }),
          ),
        );
        return Result.ok({ updated: rows.length });
      }

      case "mark_non_billable": {
        const rows = yield* Result.await(
          safeDb((tx) =>
            tx
              .update(timeEntries)
              .set({ billable: false, updatedAt: new Date() })
              .where(
                and(
                  condition,
                  ne(timeEntries.status, BILLING_STATUS.BILLED),
                  ne(timeEntries.status, BILLING_STATUS.WRITTEN_OFF),
                ),
              )
              .returning({ id: timeEntries.id }),
          ),
        );
        return Result.ok({ updated: rows.length });
      }

      default:
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid action" }),
        );
    }
  },
);

export default batchUpdate;
