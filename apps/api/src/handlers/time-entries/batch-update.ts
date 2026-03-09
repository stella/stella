import { and, eq, inArray, ne } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import { BILLING_STATUS, timeEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
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

type BatchUpdateBodySchema = Static<typeof batchUpdateBodySchema>;

type BatchUpdateHandlerProps = {
  workspaceId: SafeId<"workspace">;
  body: BatchUpdateBodySchema;
};

export const batchUpdateHandler = async ({
  workspaceId,
  body,
}: BatchUpdateHandlerProps) => {
  const { ids, action } = body;

  const condition = and(
    eq(timeEntries.workspaceId, workspaceId),
    inArray(timeEntries.id, ids),
  );

  switch (action) {
    case "approve": {
      const result = await db
        .update(timeEntries)
        .set({ status: BILLING_STATUS.APPROVED, updatedAt: new Date() })
        .where(and(condition, eq(timeEntries.status, BILLING_STATUS.DRAFT)));
      return { updated: result.rowCount ?? 0 };
    }

    case "revert_to_draft": {
      const result = await db
        .update(timeEntries)
        .set({ status: BILLING_STATUS.DRAFT, updatedAt: new Date() })
        .where(and(condition, eq(timeEntries.status, BILLING_STATUS.APPROVED)));
      return { updated: result.rowCount ?? 0 };
    }

    case "mark_billable": {
      const result = await db
        .update(timeEntries)
        .set({ billable: true, updatedAt: new Date() })
        .where(
          and(
            condition,
            ne(timeEntries.status, BILLING_STATUS.BILLED),
            ne(timeEntries.status, BILLING_STATUS.WRITTEN_OFF),
          ),
        );
      return { updated: result.rowCount ?? 0 };
    }

    case "mark_non_billable": {
      const result = await db
        .update(timeEntries)
        .set({ billable: false, updatedAt: new Date() })
        .where(
          and(
            condition,
            ne(timeEntries.status, BILLING_STATUS.BILLED),
            ne(timeEntries.status, BILLING_STATUS.WRITTEN_OFF),
          ),
        );
      return { updated: result.rowCount ?? 0 };
    }

    default:
      return status(400, { message: "Invalid action" });
  }
};
