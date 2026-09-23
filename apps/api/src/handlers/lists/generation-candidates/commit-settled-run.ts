import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { legalListGenerationRuns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type CommitSettledRunOptions = {
  runId: SafeId<"legalListGenerationRun">;
  listId: SafeId<"legalList">;
  workspaceId: SafeId<"workspace">;
};

/** Mark a generation run committed once none of its candidates await a decision. */
export const commitSettledRun = async (
  tx: Transaction,
  { runId, listId, workspaceId }: CommitSettledRunOptions,
) => {
  const pending = await tx.query.legalListGenerationCandidates.findFirst({
    where: {
      runId: { eq: runId },
      listId: { eq: listId },
      workspaceId: { eq: workspaceId },
      status: { in: ["pending", "accepting"] },
    },
    columns: { id: true },
  });
  if (pending) {
    return;
  }
  // audit: skip — callers record the candidate decision in the same transaction.
  await tx
    .update(legalListGenerationRuns)
    .set({ status: "committed", updatedAt: new Date() })
    .where(
      and(
        eq(legalListGenerationRuns.id, runId),
        eq(legalListGenerationRuns.listId, listId),
        eq(legalListGenerationRuns.workspaceId, workspaceId),
      ),
    );
};
