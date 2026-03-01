import { and, eq, inArray, ne } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import { timeEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";

export const batchUpdateBodySchema = t.Object({
  ids: t.Array(tNanoid, { minItems: 1, maxItems: 200 }),
  action: t.UnionEnum([
    "approve",
    "revert_to_draft",
    "mark_billable",
    "mark_non_billable",
    "delete",
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
        .set({ status: "approved", updatedAt: new Date() })
        .where(and(condition, eq(timeEntries.status, "draft")));
      return { updated: result.rowCount ?? 0 };
    }

    case "revert_to_draft": {
      const result = await db
        .update(timeEntries)
        .set({ status: "draft", updatedAt: new Date() })
        .where(and(condition, eq(timeEntries.status, "approved")));
      return { updated: result.rowCount ?? 0 };
    }

    case "mark_billable": {
      const result = await db
        .update(timeEntries)
        .set({ billable: true, updatedAt: new Date() })
        .where(
          and(
            condition,
            ne(timeEntries.status, "billed"),
            ne(timeEntries.status, "written_off"),
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
            ne(timeEntries.status, "billed"),
            ne(timeEntries.status, "written_off"),
          ),
        );
      return { updated: result.rowCount ?? 0 };
    }

    case "delete": {
      // Draft entries: hard delete. Non-draft: write off.
      // Wrapped in a transaction for atomicity.
      const updated = await db.transaction(async (tx) => {
        const deleted = await tx
          .delete(timeEntries)
          .where(and(condition, eq(timeEntries.status, "draft")));

        const writtenOff = await tx
          .update(timeEntries)
          .set({
            status: "written_off",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(timeEntries.workspaceId, workspaceId),
              inArray(timeEntries.id, ids),
              ne(timeEntries.status, "written_off"),
              ne(timeEntries.status, "billed"),
            ),
          );

        return (deleted.rowCount ?? 0) + (writtenOff.rowCount ?? 0);
      });

      return { updated };
    }

    default:
      return status(400, { message: "Invalid action" });
  }
};
