import { and, eq, inArray } from "drizzle-orm";

import { answerNeedsRun } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import { caseLawResearchAnswers } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
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

/** One cell a run owns: the question and the decision it is asked of. */
export type ResearchAnswerCell = {
  columnId: SafeId<"caseLawResearchColumn">;
  decisionId: SafeId<"caseLawDecision">;
};

/** What one run may answer, and the id that proves the cells are still its own. */
export type ResearchAnswerClaim = {
  claimId: SafeId<"caseLawResearchAnswerClaim">;
  cells: ResearchAnswerCell[];
};

const cellKey = (
  columnId: SafeId<"caseLawResearchColumn">,
  decisionId: SafeId<"caseLawDecision">,
): string => `${columnId}:${decisionId}`;

/**
 * Whether a cell has to be answered again.
 *
 * The state policy is `answerNeedsRun`, shared with the client so the cells a
 * lawyer confirms are the cells that run. `force` is the caller's decision
 * rather than the cell's state: it reopens an answered cell, which is the one
 * the policy keeps for the sake of paging back to an answered page free.
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
    return answerNeedsRun({ state: null, stale: false });
  }
  if (force && cell.state === "answered") {
    return true;
  }
  return answerNeedsRun({
    state: cell.state,
    stale: cell.updatedAt.getTime() < staleBefore,
  });
};

/**
 * Claim every (column, decision) cell the run has to produce: mark it pending
 * under a fresh claim id and report the cells claimed. Cells already answered,
 * or already being worked on, are left exactly as they are and are NOT
 * returned, so the runner works its own claim rather than the whole rectangle.
 * The claim id is what a later write is checked against: a run that stalled
 * past the stale window and woke up holds an id no row carries any more.
 */
export const queueResearchAnswerCells = async ({
  columnIds,
  decisionIds,
  force,
  now,
  organizationId,
  tx,
}: QueueResearchAnswerCellsOptions): Promise<ResearchAnswerClaim> => {
  const claimId = createSafeId<"caseLawResearchAnswerClaim">();
  if (columnIds.length === 0 || decisionIds.length === 0) {
    return { claimId, cells: [] };
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

  const cells: ResearchAnswerCell[] = [];
  for (const columnId of columnIds) {
    for (const decisionId of decisionIds) {
      const cell = existingByKey.get(cellKey(columnId, decisionId));
      if (!needsAnswer({ cell, force, staleBefore })) {
        continue;
      }
      cells.push({ columnId, decisionId });
    }
  }
  if (cells.length === 0) {
    return { claimId, cells };
  }

  await tx
    .insert(caseLawResearchAnswers)
    .values(
      cells.map((cell) => ({
        columnId: cell.columnId,
        organizationId,
        decisionId: cell.decisionId,
        state: "pending" as const,
        claimId,
        answer: null,
        run: null,
        failureReason: null,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [
        caseLawResearchAnswers.columnId,
        caseLawResearchAnswers.decisionId,
      ],
      set: {
        state: "pending",
        claimId,
        answer: null,
        run: null,
        failureReason: null,
        updatedAt: now,
      },
    });
  return { claimId, cells };
};
