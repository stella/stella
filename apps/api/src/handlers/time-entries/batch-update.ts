import { and, eq, inArray, ne } from "drizzle-orm";
import { status, t } from "elysia";

import { BILLING_STATUS, timeEntries } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

export const batchUpdateBodySchema = t.Object({
  ids: t.Array(tNanoid, { minItems: 1, maxItems: 200 }),
  action: t.UnionEnum([
    "approve",
    "revert_to_draft",
    "mark_billable",
    "mark_non_billable",
  ]),
});

const batchUpdate = createHandler(
  {
    permissions: { timeEntry: ["update"] },
    body: batchUpdateBodySchema,
  },
  async ({ scopedDb, workspaceId, body }) => {
    const { ids, action } = body;

    const condition = and(
      eq(timeEntries.workspaceId, workspaceId),
      inArray(timeEntries.id, ids),
    );

    switch (action) {
      case "approve": {
        const rows = await scopedDb((tx) =>
          tx
            .update(timeEntries)
            .set({ status: BILLING_STATUS.APPROVED, updatedAt: new Date() })
            .where(and(condition, eq(timeEntries.status, BILLING_STATUS.DRAFT)))
            .returning({ id: timeEntries.id }),
        );
        return { updated: rows.length };
      }

      case "revert_to_draft": {
        const rows = await scopedDb((tx) =>
          tx
            .update(timeEntries)
            .set({ status: BILLING_STATUS.DRAFT, updatedAt: new Date() })
            .where(
              and(condition, eq(timeEntries.status, BILLING_STATUS.APPROVED)),
            )
            .returning({ id: timeEntries.id }),
        );
        return { updated: rows.length };
      }

      case "mark_billable": {
        const rows = await scopedDb((tx) =>
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
        );
        return { updated: rows.length };
      }

      case "mark_non_billable": {
        const rows = await scopedDb((tx) =>
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
        );
        return { updated: rows.length };
      }

      default:
        return status(400, { message: "Invalid action" });
    }
  },
);

export default batchUpdate;
