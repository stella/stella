import { panic } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawResearchAnswers } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type ExistingCell = {
  columnId: SafeId<"caseLawResearchColumn">;
  decisionId: SafeId<"caseLawDecision">;
  state: (typeof caseLawResearchAnswers.$inferSelect)["state"];
  updatedAt: Date;
};

type QueueResearchAnswerCellsOptions = {
  tx: Pick<Transaction, "insert" | "select">;
  organizationId: SafeId<"organization">;
  columnIds: readonly SafeId<"caseLawResearchColumn">[];
  decisionIds: readonly SafeId<"caseLawDecision">[];
  /** Re-answer cells that already hold an answer. */
  force: boolean;
  now: Date;
};

const cellKey = (
  columnId: SafeId<"caseLawResearchColumn">,
  decisionId: SafeId<"caseLawDecision">,
): string => `${columnId}:${decisionId}`;

/**
 * Whether a cell has to be answered again.
 *
 * A live pending cell belongs to another run; a pending cell that has gone
 * quiet past the stale window is a run that died, so it may be claimed. An
 * answered cell is kept unless the caller forces: that is what makes paging
 * back to a page already answered free.
 */
const needsAnswer = ({
  cell,
  force,
  staleBefore,
}: {
  cell: ExistingCell | undefined;
  force: boolean;
  staleBefore: number;
}): boolean => {
  if (cell === undefined) {
    return true;
  }
  switch (cell.state) {
    case "pending":
      return cell.updatedAt.getTime() < staleBefore;
    case "answered":
      return force;
    case "not_allowed":
    case "failed":
      return true;
    default:
      cell.state satisfies never;
      return panic(`Unhandled answer state: ${String(cell.state)}`);
  }
};

/**
 * Mark every (column, decision) cell the run has to produce as pending, and
 * report how many. Cells already answered, or already being worked on, are
 * left exactly as they are.
 */
export const queueResearchAnswerCells = async ({
  columnIds,
  decisionIds,
  force,
  now,
  organizationId,
  tx,
}: QueueResearchAnswerCellsOptions): Promise<number> => {
  if (columnIds.length === 0 || decisionIds.length === 0) {
    return 0;
  }
  const existing = await tx
    .select({
      columnId: caseLawResearchAnswers.columnId,
      decisionId: caseLawResearchAnswers.decisionId,
      state: caseLawResearchAnswers.state,
      updatedAt: caseLawResearchAnswers.updatedAt,
    })
    .from(caseLawResearchAnswers)
    .where(
      and(
        inArray(caseLawResearchAnswers.columnId, [...columnIds]),
        inArray(caseLawResearchAnswers.decisionId, [...decisionIds]),
        eq(caseLawResearchAnswers.organizationId, organizationId),
      ),
    );
  const existingByKey = new Map(
    existing.map((cell) => [cellKey(cell.columnId, cell.decisionId), cell]),
  );
  const staleBefore = now.getTime() - LIMITS.caseLawResearchPendingStaleMs;

  const toQueue: (typeof caseLawResearchAnswers.$inferInsert)[] = [];
  for (const columnId of columnIds) {
    for (const decisionId of decisionIds) {
      const cell = existingByKey.get(cellKey(columnId, decisionId));
      if (!needsAnswer({ cell, force, staleBefore })) {
        continue;
      }
      toQueue.push({
        columnId,
        organizationId,
        decisionId,
        state: "pending",
        answer: null,
        confidence: null,
        run: null,
        failureReason: null,
        updatedAt: now,
      });
    }
  }
  if (toQueue.length === 0) {
    return 0;
  }

  await tx
    .insert(caseLawResearchAnswers)
    .values(toQueue)
    .onConflictDoUpdate({
      target: [
        caseLawResearchAnswers.columnId,
        caseLawResearchAnswers.decisionId,
      ],
      set: {
        state: "pending",
        answer: null,
        confidence: null,
        run: null,
        failureReason: null,
        updatedAt: now,
      },
    });
  return toQueue.length;
};
